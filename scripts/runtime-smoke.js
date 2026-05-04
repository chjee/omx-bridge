#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const dispatchDir = path.join(repoRoot, 'omx-dispatch');
const distMain = path.join(repoRoot, 'dist', 'main.js');
const dispatchMain = path.join(dispatchDir, 'dist', 'index.js');
const apiToken = 'runtime-smoke-token';
const dispatchRequire = createRequire(path.join(dispatchDir, 'package.json'));
const liveOmxEnvAllowlist = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSH_AUTH_SOCK',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OMX_DEFAULT_FRONTIER_MODEL',
  'OMX_DEFAULT_SPARK_MODEL',
  'OMX_DEFAULT_STANDARD_MODEL',
];
const liveOmxFakeEnvAllowlist = [
  ...liveOmxEnvAllowlist,
  'OMX_LIVE_SMOKE_EXPECTED_MARKER',
];

const children = [];
const servers = [];

function log(message) {
  process.stdout.write(`[runtime-smoke] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function findExecutable(name) {
  if (path.isAbsolute(name)) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next PATH entry
    }
  }
  return null;
}

function createSuccessShim(dir) {
  const filePath = path.join(dir, 'fake-omx-success.sh');
  writeExecutable(filePath, [
    '#!/usr/bin/env sh',
    'while IFS= read -r _line; do',
    '  :',
    'done',
    'printf "OK\\n"',
    '',
  ].join('\n'));
  return filePath;
}

function createLiveOmxShim(dir) {
  const filePath = path.join(dir, 'fake-omx-live.sh');
  writeExecutable(filePath, [
    '#!/usr/bin/env sh',
    'while IFS= read -r _line; do',
    '  :',
    'done',
    'printf "%s\\n" "$OMX_LIVE_SMOKE_EXPECTED_MARKER"',
    '',
  ].join('\n'));
  return filePath;
}

function collectAllowedEnv(keys) {
  const env = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function createWaitShim(dir) {
  const filePath = path.join(dir, 'fake-omx-wait.sh');
  writeExecutable(filePath, [
    '#!/usr/bin/env sh',
    'while IFS= read -r _line; do',
    '  :',
    'done',
    "trap 'exit 0' TERM INT",
    'while :; do',
    '  sleep 1',
    'done',
    '',
  ].join('\n'));
  return filePath;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => {
        if (!port) {
          reject(new Error('failed to allocate a local port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function startNotifyServer() {
  return new Promise((resolve, reject) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
          json: body ? JSON.parse(body) : null,
        });
        res.writeHead(204);
        res.end();
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      if (!port) {
        reject(new Error('failed to start notify server'));
        return;
      }
      servers.push(server);
      resolve({ server, port, requests });
    });
  });
}

function startBridge({
  port,
  jobsDir,
  omxCommand,
  allowedCwdPrefixes,
  bridgeEnv = {},
  omxEnvAllowlist = 'PATH',
}) {
  const child = spawn(process.execPath, [distMain], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      USER: process.env.USER ?? '',
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      ...bridgeEnv,
      PORT: String(port),
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_JOBS_DIR: jobsDir,
      OMX_COMMAND: omxCommand,
      BRIDGE_ALLOWED_CWD_PREFIXES: allowedCwdPrefixes ?? repoRoot,
      BRIDGE_OMX_ENV_ALLOWLIST: omxEnvAllowlist,
      NOTIFY_MODE: 'claude',
      BRIDGE_API_TOKEN: apiToken,
      BRIDGE_JOB_POLL_INTERVAL_MS: '50',
      BRIDGE_NOTIFY_RETRY_DELAYS_MS: '1',
      BRIDGE_NOTIFY_TIMEOUT_MS: '500',
      BRIDGE_MAX_CONCURRENCY: '4',
      BRIDGE_MAX_OUTPUT_CHARS: '32000',
      CLAUDE_NOTIFY_URL: '',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_NOTIFY_CHAT_ID: '',
      OPENCLAW_HOOKS_URL: '',
      OPENCLAW_HOOKS_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (chunk) => {
    child.output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    child.output += chunk.toString();
  });
  children.push(child);
  return child;
}

async function waitForBridge(port) {
  const deadline = Date.now() + 8_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const stats = await requestJson(port, 'GET', '/jobs/stats');
      assert(typeof stats.activeCount === 'number', 'bridge stats did not include activeCount');
      return stats;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`bridge on port ${port} did not become ready: ${String(lastError)}`);
}

async function requestJson(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${route} failed (${response.status}): ${text}`);
  }
  return parsed;
}

async function waitForTerminalJob(port, jobId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await requestJson(port, 'GET', `/jobs/${encodeURIComponent(jobId)}`);
    if (['succeeded', 'failed', 'cancelled'].includes(latest.status)) {
      return latest;
    }
    await delay(100);
  }
  throw new Error(`job ${jobId} did not reach a terminal state; latest=${JSON.stringify(latest)}`);
}

async function waitForRunningJob(port, jobId) {
  const deadline = Date.now() + 8_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await requestJson(port, 'GET', `/jobs/${encodeURIComponent(jobId)}`);
    if (latest.status === 'running') {
      return latest;
    }
    if (['succeeded', 'failed', 'cancelled'].includes(latest.status)) {
      throw new Error(`job ${jobId} became terminal before cancel: ${latest.status}`);
    }
    await delay(100);
  }
  throw new Error(`job ${jobId} did not enter running state; latest=${JSON.stringify(latest)}`);
}

async function waitForNotifyOutcome(port, jobId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await requestJson(port, 'GET', `/jobs/${encodeURIComponent(jobId)}`);
    if (latest.notifyOutcome) {
      return latest;
    }
    await delay(100);
  }
  throw new Error(`job ${jobId} did not persist notifyOutcome; latest=${JSON.stringify(latest)}`);
}

async function stopChild(child, killTimeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore cleanup errors
      }
      resolve();
    }, killTimeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function closeServers() {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.close(() => resolve());
  })));
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    let killTimeout;
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      callback();
    };
    timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      killTimeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore cleanup errors
        }
      }, options.killTimeoutMs ?? 2_000);
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore cleanup errors
      }
      reject(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs ?? 10_000}ms`));
    }, options.timeoutMs ?? 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      if (settled) {
        clearTimeout(killTimeout);
        return;
      }
      settle(() => reject(error));
    });
    child.once('close', (code) => {
      if (settled) {
        clearTimeout(killTimeout);
        return;
      }
      settle(() => {
        if (code !== 0) {
          reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  });
}

async function smokeBridgeApi() {
  const tempDir = makeTempDir('omx-bridge-smoke-api-');
  const notify = await startNotifyServer();
  const port = await getFreePort();
  const bridge = startBridge({
    port,
    jobsDir: tempDir,
    omxCommand: createSuccessShim(tempDir),
  });
  try {
    await waitForBridge(port);

    const dispatchSubmit = await requestJson(port, 'POST', '/jobs', {
      prompt: 'runtime smoke dispatch notify',
      requestId: 'runtime-smoke-dispatch-notify',
      source: 'dispatch',
      sourceName: 'omx-dispatch',
      originRoutingKey: 'telegram:direct:123',
      notifyUrl: `http://127.0.0.1:${notify.port}/notify`,
      metadata: { smoke: 'runtime' },
    });
    const dispatchJob = await waitForNotifyOutcome(port, dispatchSubmit.jobId);
    assert(dispatchJob.status === 'succeeded', `dispatch job status was ${dispatchJob.status}`);
    assert(dispatchJob.stdout === 'OK\n', 'dispatch job stdout was not captured');
    assert(dispatchJob.originRoutingKey === 'telegram:direct:123', 'originRoutingKey was not preserved');
    assert(dispatchJob.sourceName === 'omx-dispatch', 'sourceName was not preserved');
    assert(dispatchJob.metadata?.smoke === 'runtime', 'metadata was not preserved');
    assert(dispatchJob.notifyOutcome?.claudeWebhook?.status === 'ok', 'per-job notifyUrl did not report ok');
    assert(dispatchJob.notifyOutcome?.telegram?.skippedReason === 'webhook_ok', 'telegram was not skipped after webhook ok');
    assert(notify.requests.some((request) => request.json?.id === dispatchSubmit.jobId), 'local notify server did not receive dispatch callback');

    const openclawSubmit = await requestJson(port, 'POST', '/jobs', {
      prompt: 'runtime smoke openclaw fields',
      requestId: 'runtime-smoke-openclaw-fields',
      source: 'openclaw',
      sourceName: 'openclaw-telegram',
      originRoutingKey: 'telegram:direct:456',
      metadata: { channel: 'openclaw' },
    });
    const openclawJob = await waitForNotifyOutcome(port, openclawSubmit.jobId);
    assert(openclawJob.status === 'succeeded', `openclaw job status was ${openclawJob.status}`);
    assert(openclawJob.source === 'openclaw', 'openclaw source was not preserved');
    assert(openclawJob.sourceName === 'openclaw-telegram', 'openclaw sourceName was not preserved');
    assert(openclawJob.originRoutingKey === 'telegram:direct:456', 'openclaw originRoutingKey was not preserved');
    assert(openclawJob.metadata?.channel === 'openclaw', 'openclaw metadata was not preserved');
    assert(openclawJob.notifyOutcome?.claudeWebhook?.skippedReason === 'no_notify_url', 'missing CLAUDE_NOTIFY_URL was not recorded');
    assert(openclawJob.notifyOutcome?.telegram?.skippedReason === 'not_configured', 'unconfigured Telegram fallback was not recorded');
  } finally {
    await stopChild(bridge);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  log('bridge API submit/get/notifyUrl and OpenClaw field preservation passed');
}

async function smokeCancelPath() {
  const tempDir = makeTempDir('omx-bridge-smoke-cancel-');
  const port = await getFreePort();
  const bridge = startBridge({
    port,
    jobsDir: tempDir,
    omxCommand: createWaitShim(tempDir),
  });
  try {
    await waitForBridge(port);
    const submit = await requestJson(port, 'POST', '/jobs', {
      prompt: 'runtime smoke cancel',
      requestId: 'runtime-smoke-cancel',
      source: 'openclaw',
    });
    await waitForRunningJob(port, submit.jobId);
    const cancelResponse = await requestJson(port, 'POST', `/jobs/${encodeURIComponent(submit.jobId)}/cancel`);
    assert(cancelResponse.status === 'cancelled', `cancel response status was ${cancelResponse.status}`);
    const cancelledJob = await waitForNotifyOutcome(port, submit.jobId);
    assert(cancelledJob.status === 'cancelled', `cancelled job status was ${cancelledJob.status}`);
    assert(cancelledJob.execution?.errorType === 'cancelled', 'cancelled job did not record errorType=cancelled');
    assert(cancelledJob.notifyOutcome?.claudeWebhook?.skippedReason === 'no_notify_url', 'cancel notify did not record missing CLAUDE_NOTIFY_URL');
    assert(cancelledJob.notifyOutcome?.telegram?.skippedReason === 'not_configured', 'cancel notify did not record unconfigured Telegram');
  } finally {
    await stopChild(bridge);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  log('cancel path passed');
}

async function smokeDispatchMcp() {
  const tempDir = makeTempDir('omx-bridge-smoke-dispatch-');
  const bridgePort = await getFreePort();
  const webhookPort = await getFreePort();
  const bridge = startBridge({
    port: bridgePort,
    jobsDir: tempDir,
    omxCommand: createSuccessShim(tempDir),
  });
  await waitForBridge(bridgePort);

  const { Client } = require(dispatchRequire.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { StdioClientTransport } = require(dispatchRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [dispatchMain],
    cwd: dispatchDir,
    env: {
      BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
      BRIDGE_API_TOKEN: apiToken,
      WEBHOOK_PORT: String(webhookPort),
      OMX_DISPATCH_NOTIFICATION_STORE_PATH: path.join(tempDir, 'notifications.jsonl'),
      OMX_DISPATCH_WAIT_TIMEOUT_MS: '10000',
      OMX_DISPATCH_WAIT_POLL_INTERVAL_MS: '100',
      OMX_DISPATCH_TERMINAL_NOTIFICATION_GRACE_MS: '2000',
      ENABLE_CLAUDE_CHANNEL: 'false',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'runtime-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    const health = parseToolJson(await client.callTool({ name: 'omx_health', arguments: {} }));
    assert(health.bridge?.reachable === true, 'omx_health did not report bridge reachable');
    const wait = parseToolJson(await client.callTool({
      name: 'omx_submit_job_and_wait',
      arguments: {
        prompt: 'runtime smoke dispatch mcp',
        requestId: 'runtime-smoke-dispatch-mcp',
        source: 'dispatch',
        waitTimeoutMs: 10000,
        pollIntervalMs: 100,
      },
    }));
    assert(wait.completed === true, 'omx_submit_job_and_wait did not complete');
    assert(wait.status === 'succeeded', `dispatch wait status was ${wait.status}`);
    assert(wait.notification?.job?.notifyUrl === `http://127.0.0.1:${webhookPort}/notify`, 'dispatch notifyUrl was not the session webhook');
    assert(wait.job?.stdout === 'OK\n', 'dispatch MCP job stdout was not captured');
  } finally {
    await client.close().catch(() => undefined);
    await stopChild(bridge);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  log('omx-dispatch MCP health and submit-and-wait passed');
}

function parseToolJson(result) {
  const text = result?.content?.[0]?.text;
  assert(typeof text === 'string', 'MCP tool did not return text content');
  return JSON.parse(text);
}

async function smokeOpenClawPluginDiscovery() {
  const openclawPath = findExecutable('openclaw');
  if (!openclawPath) {
    log('openclaw CLI not found; plugin discovery skipped');
    return;
  }
  const info = await runCommand(openclawPath, ['plugins', 'info', 'omx-bridge-plugin'], { timeoutMs: 15_000 });
  assert(info.stdout.includes('Status: loaded'), 'OpenClaw plugin is not loaded');
  for (const tool of ['omx_submit_job', 'omx_get_job', 'omx_list_jobs', 'omx_cancel_job']) {
    assert(info.stdout.includes(tool), `OpenClaw plugin info did not include ${tool}`);
  }
  log('OpenClaw plugin discovery passed');
}

function resolveLiveOmxCommand() {
  const command = process.env.OMX_LIVE_SMOKE_COMMAND || process.env.OMX_COMMAND || 'omx';
  const resolved = findExecutable(command);
  assert(resolved, `live OMX command not found or not executable: ${command}`);
  return command;
}

function buildLiveOmxPrompt() {
  const nonce = crypto.randomBytes(4).toString('hex');
  const markerParts = ['OMX', '_BRIDGE', '_LIVE', '_SMOKE', '_OK'];
  const marker = `${markerParts.join('')}_${nonce}`;
  return {
    marker,
    prompt: [
      'You are running a live omx-bridge smoke check.',
      'Print exactly one token and no explanation.',
      `Build the token by concatenating these quoted parts with no spaces or separators: ${markerParts.map((part) => `"${part}"`).join(', ')}`,
      `Then append one underscore and this nonce: ${nonce}`,
      'Do not edit files, install dependencies, start services, or make network calls beyond the model/tool runtime already required by OMX.',
    ].join('\n'),
  };
}

function getLiveOmxTimeoutMs() {
  return parsePositiveInt(process.env.OMX_LIVE_SMOKE_TIMEOUT_MS, 300_000);
}

async function smokeLiveOmxExec({ fake = false } = {}) {
  const tempDir = makeTempDir('omx-bridge-live-smoke-');
  const notify = await startNotifyServer();
  const port = await getFreePort();
  const omxCommand = fake ? createLiveOmxShim(tempDir) : resolveLiveOmxCommand();
  const { marker, prompt } = buildLiveOmxPrompt();
  const timeoutMs = getLiveOmxTimeoutMs();
  const bridge = startBridge({
    port,
    jobsDir: path.join(tempDir, 'jobs'),
    omxCommand,
    allowedCwdPrefixes: tempDir,
    omxEnvAllowlist: (fake ? liveOmxFakeEnvAllowlist : liveOmxEnvAllowlist).join(','),
    bridgeEnv: {
      ...collectAllowedEnv(liveOmxEnvAllowlist),
      ...(fake ? { OMX_LIVE_SMOKE_EXPECTED_MARKER: marker } : {}),
      BRIDGE_JOB_TIMEOUT_MS: String(timeoutMs),
      BRIDGE_SIGKILL_GRACE_MS: '5000',
    },
  });
  try {
    await waitForBridge(port);
    const submit = await requestJson(port, 'POST', '/jobs', {
      prompt,
      requestId: `runtime-smoke-live-omx-${Date.now()}`,
      source: 'dispatch',
      sourceName: 'runtime-smoke-live',
      originRoutingKey: 'runtime-smoke:live',
      cwd: tempDir,
      notifyUrl: `http://127.0.0.1:${notify.port}/notify`,
      metadata: { smoke: 'live-omx' },
    });
    const job = await waitForNotifyOutcome(port, submit.jobId, timeoutMs + 15_000);
    assert(job.status === 'succeeded', `live OMX job status was ${job.status}; stderr=${job.stderr || '<empty>'}`);
    assert(
      job.stdout.includes(marker),
      `live OMX job output did not include ${marker}; stdout=${job.stdout || '<empty>'}`,
    );
    assert(job.execution?.command === omxCommand, 'live OMX job did not record the selected OMX command');
    assert(job.notifyOutcome?.claudeWebhook?.status === 'ok', 'live OMX notifyUrl did not report ok');
    assert(notify.requests.some((request) => request.json?.id === submit.jobId), 'local notify server did not receive live OMX callback');
  } finally {
    await stopChild(bridge, 7_000);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  log(`${fake ? 'fake ' : ''}live OMX exec smoke passed`);
}

async function smokeLoopbackRuntime() {
  assert(fs.existsSync(distMain), 'dist/main.js not found; run npm run build first');
  assert(fs.existsSync(dispatchMain), 'omx-dispatch/dist/index.js not found; run npm --prefix omx-dispatch run build first');
  await smokeBridgeApi();
  await smokeCancelPath();
  await smokeDispatchMcp();
  await smokeOpenClawPluginDiscovery();
  log('runtime smoke passed');
}

async function main() {
  assert(fs.existsSync(distMain), 'dist/main.js not found; run npm run build first');
  const mode = process.argv[2] || '--loopback';
  if (mode === '--loopback') {
    await smokeLoopbackRuntime();
    return;
  }
  if (mode === '--live-omx') {
    await smokeLiveOmxExec();
    return;
  }
  if (mode === '--live-omx-fake') {
    await smokeLiveOmxExec({ fake: true });
    return;
  }
  fail(`unknown runtime smoke mode: ${mode}`);
}

main().catch(async (error) => {
  process.stderr.write(`[runtime-smoke] failed: ${error.stack ?? error}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await Promise.all(children.map((child) => stopChild(child)));
  await closeServers();
});
