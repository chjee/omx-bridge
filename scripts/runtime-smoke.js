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
const keepRuntimeSmokeDir = process.env.KEEP_RUNTIME_SMOKE_DIR === '1';
const verboseRuntimeSmokeDiagnostics = process.env.RUNTIME_SMOKE_DIAGNOSTICS_VERBOSE === '1';

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

function truncateForDiagnostic(value, maxChars = 4_000) {
  if (!value) {
    return '';
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, 1_000)}\n...<truncated ${value.length - maxChars} chars>...\n${value.slice(-(maxChars - 1_000))}`;
}

function redactDiagnosticText(value) {
  if (!value) {
    return '';
  }
  return value
    .replace(/(bearer\s+)[^\s"']+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s"',}]+/gi, '$1<redacted>')
    .replace(/([?&](?:api[_-]?key|token|secret|password|authorization)=)[^&\s"']+/gi, '$1<redacted>');
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

function createTmuxOmxShim(dir) {
  const filePath = path.join(dir, 'fake-omx-tmux.sh');
  writeExecutable(filePath, [
    '#!/usr/bin/env sh',
    'if [ "${1-}" != "exec" ]; then',
    '  echo "unexpected omx command: ${1-}" >&2',
    '  exit 64',
    'fi',
    'prompt="$(cat)"',
    'printf "TMUX_OK:%s\\n" "$prompt"',
    '',
  ].join('\n'));
  return filePath;
}

function createTmuxWaitOmxShim(dir) {
  const filePath = path.join(dir, 'fake-omx-tmux-wait.sh');
  writeExecutable(filePath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [ "${1-}" != "exec" ]; then',
    '  echo "unexpected omx command: ${1-}" >&2',
    '  exit 64',
    'fi',
    'prompt="$(cat)"',
    'printf "TMUX_WAIT:%s\\n" "$prompt"',
    'trap \'printf "TMUX_WAIT_CANCELLED\\n" >&2; exit 143\' TERM INT',
    'while :; do',
    '  sleep 1',
    'done',
    '',
  ].join('\n'));
  return filePath;
}

function createFakeTmuxShim(dir) {
  const filePath = path.join(dir, 'fake-tmux.sh');
  writeExecutable(filePath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'cmd="${1-}"',
    'shift || true',
    'state_dir="${FAKE_TMUX_STATE_DIR:?}"',
    'mkdir -p "$state_dir"',
    'case "$cmd" in',
    '  new-session)',
    '    session=""',
    '    workdir=""',
    '    command=""',
    '    while [ "$#" -gt 0 ]; do',
    '      case "$1" in',
    '        -d) shift ;;',
    '        -s) session="${2-}"; shift 2 ;;',
    '        -c) workdir="${2-}"; shift 2 ;;',
    '        *) command="$1"; shift ;;',
    '      esac',
    '    done',
    '    if [ -z "$session" ] || [ -z "$command" ]; then',
    '      echo "missing fake tmux session or command" >&2',
    '      exit 64',
    '    fi',
    '    touch "$state_dir/$session.running"',
    '    (',
    '      set +e',
    '      if [ -n "$workdir" ]; then',
    '        cd "$workdir"',
    '      fi',
    '      setsid bash -lc "$command" &',
    '      child_pid=$!',
    '      printf "%s\\n" "$child_pid" > "$state_dir/$session.pid"',
    '      wait "$child_pid"',
    '      code=$?',
    '      rm -f "$state_dir/$session.running" "$state_dir/$session.pid"',
    '      printf "%s\\n" "$code" > "$state_dir/$session.exit"',
    '    ) >/dev/null 2>/dev/null < /dev/null &',
    '    for _ in $(seq 1 100); do',
    '      [ -f "$state_dir/$session.pid" ] && break',
    '      sleep 0.01',
    '    done',
    '    exit 0',
    '    ;;',
    '  has-session)',
    '    target=""',
    '    while [ "$#" -gt 0 ]; do',
    '      case "$1" in',
    '        -t) target="${2-}"; shift 2 ;;',
    '        *) shift ;;',
    '      esac',
    '    done',
    '    [ -n "$target" ] && [ -f "$state_dir/$target.running" ]',
    '    exit $?',
    '    ;;',
    '  kill-session)',
    '    target=""',
    '    while [ "$#" -gt 0 ]; do',
    '      case "$1" in',
    '        -t) target="${2-}"; shift 2 ;;',
    '        *) shift ;;',
    '      esac',
    '    done',
    '    if [ -z "$target" ] || [ ! -f "$state_dir/$target.running" ]; then',
    '      echo "no such fake session: $target" >&2',
    '      exit 1',
    '    fi',
    '    pid_file="$state_dir/$target.pid"',
    '    if [ ! -f "$pid_file" ]; then',
    '      echo "missing fake session pid: $target" >&2',
    '      exit 1',
    '    fi',
    '    pid="$(cat "$pid_file")"',
    '    if [ -z "$pid" ]; then',
    '      echo "empty fake session pid: $target" >&2',
    '      exit 1',
    '    fi',
    '    if ! kill -TERM "-$pid" 2>/dev/null; then',
    '      kill -TERM "$pid" 2>/dev/null || exit 1',
    '    fi',
    '    rm -f "$state_dir/$target.running" "$pid_file"',
    '    printf "143\\n" > "$state_dir/$target.exit"',
    '    exit 0',
    '    ;;',
    '  *)',
    '    echo "unsupported fake tmux command: $cmd" >&2',
    '    exit 64',
    '    ;;',
    'esac',
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

function cleanupTempDir(tempDir, failed = false) {
  if (keepRuntimeSmokeDir) {
    log(`preserved ${failed ? 'failed ' : ''}runtime smoke temp dir: ${tempDir}`);
    return;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function summarizeTextField(value) {
  const text = value ?? '';
  const summary = {
    bytes: Buffer.byteLength(text),
    chars: text.length,
  };
  if (verboseRuntimeSmokeDiagnostics && text) {
    summary.preview = truncateForDiagnostic(redactDiagnosticText(text), 1_200);
  }
  return summary;
}

function metadataSummary(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  return {
    keys: Object.keys(metadata).sort(),
  };
}

function executionSummary(execution) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    return undefined;
  }
  return {
    command: execution.command ? '<redacted>' : undefined,
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: execution.durationMs,
    errorType: execution.errorType,
    timedOut: execution.timedOut,
  };
}

function notifyOutcomeSummary(notifyOutcome) {
  if (!notifyOutcome || typeof notifyOutcome !== 'object' || Array.isArray(notifyOutcome)) {
    return undefined;
  }
  const summary = {};
  for (const [channel, outcome] of Object.entries(notifyOutcome)) {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
      summary[channel] = outcome;
      continue;
    }
    summary[channel] = {
      status: outcome.status,
      skippedReason: outcome.skippedReason,
      attempts: outcome.attempts,
      statusCode: outcome.statusCode,
      errorType: outcome.errorType,
    };
  }
  return summary;
}

function listFilesRecursive(dir, predicate, limit = 30) {
  const files = [];
  const visit = (current) => {
    if (files.length >= limit || !fs.existsSync(current)) {
      return;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (predicate(entryPath)) {
        files.push(entryPath);
      }
      if (files.length >= limit) {
        return;
      }
    }
  };
  visit(dir);
  return files;
}

function summarizeJobFile(filePath) {
  try {
    const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!job || typeof job !== 'object' || !('status' in job)) {
      return null;
    }
    return {
      file: filePath,
      id: job.id,
      status: job.status,
      requestId: job.requestId,
      source: job.source,
      sourceName: job.sourceName,
      originRoutingKey: job.originRoutingKey,
      cwd: job.cwd,
      notifyUrl: job.notifyUrl ? '<redacted>' : undefined,
      metadata: metadataSummary(job.metadata),
      stdout: summarizeTextField(job.stdout),
      stderr: summarizeTextField(job.stderr),
      execution: executionSummary(job.execution),
      notifyOutcome: notifyOutcomeSummary(job.notifyOutcome),
    };
  } catch (error) {
    return {
      file: filePath,
      unreadable: String(error),
    };
  }
}

function summarizeJsonlFile(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(-5);
    return {
      file: filePath,
      tail: lines.map((line) => {
        try {
          const event = JSON.parse(line);
          return {
            id: event?.job?.id ?? event?.id,
            status: event?.job?.status ?? event?.status,
            source: event?.job?.source ?? event?.source,
            sourceName: event?.job?.sourceName ?? event?.sourceName,
          };
        } catch {
          return truncateForDiagnostic(line, 300);
        }
      }),
    };
  } catch (error) {
    return {
      file: filePath,
      unreadable: String(error),
    };
  }
}

function printSmokeDiagnostics(name, tempDir, bridges = []) {
  process.stderr.write(`\n[runtime-smoke] diagnostics for ${name}\n`);
  process.stderr.write(`[runtime-smoke] tempDir: ${tempDir}\n`);
  if (keepRuntimeSmokeDir) {
    process.stderr.write('[runtime-smoke] KEEP_RUNTIME_SMOKE_DIR=1 is set; temp dir will be preserved\n');
  } else {
    process.stderr.write('[runtime-smoke] set KEEP_RUNTIME_SMOKE_DIR=1 to preserve temp files after failures\n');
  }
  if (!verboseRuntimeSmokeDiagnostics) {
    process.stderr.write('[runtime-smoke] set RUNTIME_SMOKE_DIAGNOSTICS_VERBOSE=1 to include redacted stdout/stderr previews\n');
  }

  for (const [index, bridge] of bridges.entries()) {
    const output = bridge?.output ?? '';
    const summary = { bytes: Buffer.byteLength(output), chars: output.length };
    if (verboseRuntimeSmokeDiagnostics && output) {
      summary.preview = truncateForDiagnostic(redactDiagnosticText(output), 8_000).trim();
    }
    process.stderr.write(`[runtime-smoke] bridge[${index}] output summary:\n${JSON.stringify(summary, null, 2)}\n`);
  }

  const jobSummaries = listFilesRecursive(
    tempDir,
    (filePath) => filePath.endsWith('.json') && !filePath.endsWith('package.json'),
  )
    .map(summarizeJobFile)
    .filter(Boolean);
  if (jobSummaries.length > 0) {
    process.stderr.write(`[runtime-smoke] job json summaries:\n${JSON.stringify(jobSummaries, null, 2)}\n`);
  } else {
    process.stderr.write('[runtime-smoke] job json summaries: <none>\n');
  }

  const jsonlSummaries = listFilesRecursive(tempDir, (filePath) => filePath.endsWith('.jsonl'))
    .map(summarizeJsonlFile);
  if (jsonlSummaries.length > 0) {
    process.stderr.write(`[runtime-smoke] jsonl summaries:\n${JSON.stringify(jsonlSummaries, null, 2)}\n`);
  }
}

async function smokeDiagnosticsFixture() {
  const result = await runCommand(process.execPath, [__filename, '--diagnostics-fixture-child'], {
    env: {
      ...process.env,
      KEEP_RUNTIME_SMOKE_DIR: '1',
      RUNTIME_SMOKE_DIAGNOSTICS_VERBOSE: '1',
    },
    timeoutMs: 10_000,
  });
  assert(result.stderr.includes('[runtime-smoke] diagnostics for diagnostics fixture'), 'diagnostics fixture did not print diagnostics header');
  assert(result.stderr.includes('[runtime-smoke] job json summaries:'), 'diagnostics fixture did not print job summaries');
  assert(result.stderr.includes('"notifyUrl": "<redacted>"'), 'diagnostics fixture did not redact notifyUrl');
  assert(result.stderr.includes('"command": "<redacted>"'), 'diagnostics fixture did not redact execution command');
  assert(result.stderr.includes('token=<redacted>'), 'diagnostics fixture did not redact token-like bridge output');
  assert(!result.stderr.includes('super-secret'), 'diagnostics fixture leaked secret metadata/output');

  const preservedMatch = result.stdout.match(/preserved failed runtime smoke temp dir: (.+)$/m);
  assert(preservedMatch, 'diagnostics fixture did not preserve the temp dir with KEEP_RUNTIME_SMOKE_DIR=1');
  fs.rmSync(preservedMatch[1], { recursive: true, force: true });
  log('runtime smoke diagnostics fixture passed');
}

function emitDiagnosticsFixture() {
  const tempDir = makeTempDir('omx-bridge-smoke-diagnostics-');
  const jobsDir = path.join(tempDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, 'job.json'), JSON.stringify({
    id: 'diagnostics-fixture',
    status: 'failed',
    requestId: 'runtime-smoke-diagnostics-fixture',
    source: 'dispatch',
    sourceName: 'runtime-smoke',
    originRoutingKey: 'telegram:direct:fixture',
    cwd: tempDir,
    notifyUrl: 'http://127.0.0.1:1/notify?token=super-secret',
    metadata: {
      token: 'super-secret',
      channel: 'fixture',
    },
    stdout: 'stdout token=super-secret\n',
    stderr: 'stderr bearer super-secret\n',
    execution: {
      command: '/tmp/super-secret-command',
      exitCode: 1,
      errorType: 'process_exit',
      durationMs: 12,
    },
    notifyOutcome: {
      claudeWebhook: {
        status: 'failed',
        statusCode: 500,
        url: 'http://127.0.0.1:1/notify?token=super-secret',
      },
      telegram: {
        skippedReason: 'not_configured',
      },
    },
  }));
  fs.writeFileSync(path.join(tempDir, 'notifications.jsonl'), `${JSON.stringify({
    job: {
      id: 'diagnostics-fixture',
      status: 'failed',
      source: 'dispatch',
      sourceName: 'runtime-smoke',
    },
  })}\n`);
  printSmokeDiagnostics('diagnostics fixture', tempDir, [{ output: 'bridge output token=super-secret\n' }]);
  cleanupTempDir(tempDir, true);
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
  tmuxCommand,
  tmuxSessionsDir,
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
      ...(tmuxCommand ? { TMUX_COMMAND: tmuxCommand } : {}),
      ...(tmuxSessionsDir ? { BRIDGE_TMUX_SESSIONS_DIR: tmuxSessionsDir } : {}),
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

async function waitForRunningTmuxJob(port, jobId) {
  const deadline = Date.now() + 8_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await requestJson(port, 'GET', `/jobs/${encodeURIComponent(jobId)}`);
    if (latest.status === 'running' && latest.session?.backend === 'tmux' && latest.session.status === 'running') {
      return latest;
    }
    if (['succeeded', 'failed', 'cancelled'].includes(latest.status)) {
      throw new Error(`tmux job ${jobId} became terminal before session was running: ${latest.status}`);
    }
    await delay(100);
  }
  throw new Error(`tmux job ${jobId} did not enter running session state; latest=${JSON.stringify(latest)}`);
}

function readFakeTmuxPid(fakeTmuxStateDir, sessionName) {
  const raw = fs.readFileSync(path.join(fakeTmuxStateDir, `${sessionName}.pid`), 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  assert(Number.isFinite(pid) && pid > 0, `fake tmux pid was invalid for ${sessionName}: ${raw}`);
  return pid;
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error && (error.code === 'ESRCH' || error.code === 'EINVAL')) {
      return false;
    }
    return true;
  }
}

async function waitForFakeTmuxSessionCleanup(fakeTmuxStateDir, sessionName, pid) {
  const deadline = Date.now() + 5_000;
  const runningFile = path.join(fakeTmuxStateDir, `${sessionName}.running`);
  const pidFile = path.join(fakeTmuxStateDir, `${sessionName}.pid`);
  while (Date.now() < deadline) {
    if (!fs.existsSync(runningFile) && !fs.existsSync(pidFile) && !isProcessGroupAlive(pid)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`fake tmux session ${sessionName} was not cleaned up; pid=${pid}`);
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
  let bridge;
  let failed = false;
  try {
    const notify = await startNotifyServer();
    const port = await getFreePort();
    bridge = startBridge({
      port,
      jobsDir: tempDir,
      omxCommand: createSuccessShim(tempDir),
    });
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
  } catch (error) {
    failed = true;
    printSmokeDiagnostics('bridge API submit/get/notifyUrl and OpenClaw field preservation', tempDir, [bridge].filter(Boolean));
    throw error;
  } finally {
    await stopChild(bridge);
    cleanupTempDir(tempDir, failed);
  }
  log('bridge API submit/get/notifyUrl and OpenClaw field preservation passed');
}

async function smokeCancelPath() {
  const tempDir = makeTempDir('omx-bridge-smoke-cancel-');
  let bridge;
  let failed = false;
  try {
    const port = await getFreePort();
    bridge = startBridge({
      port,
      jobsDir: tempDir,
      omxCommand: createWaitShim(tempDir),
    });
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
  } catch (error) {
    failed = true;
    printSmokeDiagnostics('cancel path', tempDir, [bridge].filter(Boolean));
    throw error;
  } finally {
    await stopChild(bridge);
    cleanupTempDir(tempDir, failed);
  }
  log('cancel path passed');
}

async function smokeTmuxRuntime() {
  const tempDir = makeTempDir('omx-bridge-smoke-tmux-');
  let bridge;
  let failed = false;
  try {
    const jobsDir = path.join(tempDir, 'jobs');
    const tmuxSessionsDir = path.join(tempDir, 'sessions');
    const fakeTmuxStateDir = path.join(tempDir, 'fake-tmux-state');
    fs.mkdirSync(fakeTmuxStateDir, { recursive: true });

    const port = await getFreePort();
    bridge = startBridge({
      port,
      jobsDir,
      omxCommand: createTmuxOmxShim(tempDir),
      tmuxCommand: createFakeTmuxShim(tempDir),
      tmuxSessionsDir,
      allowedCwdPrefixes: tempDir,
      omxEnvAllowlist: 'PATH,FAKE_TMUX_STATE_DIR',
      bridgeEnv: {
        FAKE_TMUX_STATE_DIR: fakeTmuxStateDir,
      },
    });
    await waitForBridge(port);

    const submit = await requestJson(port, 'POST', '/jobs', {
      prompt: 'runtime smoke tmux',
      requestId: 'runtime-smoke-tmux',
      source: 'dispatch',
      sourceName: 'runtime-smoke-tmux',
      originRoutingKey: 'runtime-smoke:tmux',
      cwd: tempDir,
      executionMode: 'tmux',
      metadata: { smoke: 'tmux' },
    });
    const job = await waitForTerminalJob(port, submit.jobId, 10_000);
    assert(job.status === 'succeeded', `tmux job status was ${job.status}; stderr=${job.stderr || '<empty>'}`);
    assert(job.executionMode === 'tmux', 'tmux job did not preserve executionMode');
    assert(job.stdout.includes('TMUX_OK:runtime smoke tmux'), `tmux job stdout was not captured: ${job.stdout || '<empty>'}`);
    assert(job.session?.backend === 'tmux', 'tmux job did not persist session backend');
    assert(job.session?.status === 'exited', `tmux session status was ${job.session?.status}`);
    assert(job.session?.lastExitCode === 0, `tmux session lastExitCode was ${job.session?.lastExitCode}`);
    assert(job.session?.attachCommand?.includes('attach -t'), 'tmux attachCommand was not persisted');

    const sessionDir = path.join(tmuxSessionsDir, submit.jobId);
    assert(fs.existsSync(path.join(sessionDir, 'prompt.txt')), 'tmux prompt file was not created');
    assert(fs.existsSync(path.join(sessionDir, 'run.sh')), 'tmux runner script was not created');
    assert(fs.existsSync(path.join(sessionDir, 'session.json')), 'tmux session file was not created');
    assert(fs.existsSync(path.join(sessionDir, 'exit-code')), 'tmux exit-code file was not created');
    assert(fs.readFileSync(path.join(sessionDir, 'prompt.txt'), 'utf8') === 'runtime smoke tmux', 'tmux prompt file did not preserve prompt');
    assert(fs.readFileSync(path.join(sessionDir, 'exit-code'), 'utf8').trim() === '0', 'tmux exit-code file was not zero');
    const sessionFile = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assert(sessionFile.status === 'exited', `session.json status was ${sessionFile.status}`);
  } catch (error) {
    failed = true;
    printSmokeDiagnostics('tmux session runtime smoke', tempDir, [bridge].filter(Boolean));
    throw error;
  } finally {
    await stopChild(bridge);
    cleanupTempDir(tempDir, failed);
  }
  log('tmux session runtime smoke passed');
}

async function smokeTmuxCancelRuntime() {
  const tempDir = makeTempDir('omx-bridge-smoke-tmux-cancel-');
  let bridge;
  let failed = false;
  try {
    const jobsDir = path.join(tempDir, 'jobs');
    const tmuxSessionsDir = path.join(tempDir, 'sessions');
    const fakeTmuxStateDir = path.join(tempDir, 'fake-tmux-state');
    fs.mkdirSync(fakeTmuxStateDir, { recursive: true });

    const port = await getFreePort();
    bridge = startBridge({
      port,
      jobsDir,
      omxCommand: createTmuxWaitOmxShim(tempDir),
      tmuxCommand: createFakeTmuxShim(tempDir),
      tmuxSessionsDir,
      allowedCwdPrefixes: tempDir,
      omxEnvAllowlist: 'PATH,FAKE_TMUX_STATE_DIR',
      bridgeEnv: {
        FAKE_TMUX_STATE_DIR: fakeTmuxStateDir,
        BRIDGE_JOB_TIMEOUT_MS: '10000',
      },
    });
    await waitForBridge(port);

    const submit = await requestJson(port, 'POST', '/jobs', {
      prompt: 'runtime smoke tmux cancel',
      requestId: 'runtime-smoke-tmux-cancel',
      source: 'dispatch',
      sourceName: 'runtime-smoke-tmux-cancel',
      originRoutingKey: 'runtime-smoke:tmux-cancel',
      cwd: tempDir,
      executionMode: 'tmux',
      metadata: { smoke: 'tmux-cancel' },
    });
    const runningJob = await waitForRunningTmuxJob(port, submit.jobId);
    const sessionName = runningJob.session.sessionName;
    const tmuxPid = readFakeTmuxPid(fakeTmuxStateDir, sessionName);

    const cancelResponse = await requestJson(port, 'POST', `/jobs/${encodeURIComponent(submit.jobId)}/cancel`);
    assert(cancelResponse.status === 'cancelled', `tmux cancel response status was ${cancelResponse.status}`);
    assert(cancelResponse.session?.status === 'cancelled', `tmux cancel response session status was ${cancelResponse.session?.status}`);
    assert(cancelResponse.execution?.errorType === 'cancelled', 'tmux cancel response did not record errorType=cancelled');
    await waitForFakeTmuxSessionCleanup(fakeTmuxStateDir, sessionName, tmuxPid);

    const cancelledJob = await waitForNotifyOutcome(port, submit.jobId);
    assert(cancelledJob.status === 'cancelled', `tmux cancelled job status was ${cancelledJob.status}`);
    assert(cancelledJob.session?.status === 'cancelled', `tmux cancelled session status was ${cancelledJob.session?.status}`);
    assert(cancelledJob.execution?.errorType === 'cancelled', 'tmux cancelled job did not record errorType=cancelled');

    const sessionDir = path.join(tmuxSessionsDir, submit.jobId);
    assert(fs.existsSync(path.join(sessionDir, 'prompt.txt')), 'tmux cancel prompt file was not created');
    assert(fs.existsSync(path.join(sessionDir, 'run.sh')), 'tmux cancel runner script was not created');
    const sessionFile = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assert(sessionFile.status === 'cancelled', `tmux cancel session.json status was ${sessionFile.status}`);
  } catch (error) {
    failed = true;
    printSmokeDiagnostics('tmux session cancel smoke', tempDir, [bridge].filter(Boolean));
    throw error;
  } finally {
    await stopChild(bridge);
    cleanupTempDir(tempDir, failed);
  }
  log('tmux session cancel smoke passed');
}

async function smokeTmuxTimeoutRuntime() {
  const tempDir = makeTempDir('omx-bridge-smoke-tmux-timeout-');
  let bridge;
  let failed = false;
  try {
    const jobsDir = path.join(tempDir, 'jobs');
    const tmuxSessionsDir = path.join(tempDir, 'sessions');
    const fakeTmuxStateDir = path.join(tempDir, 'fake-tmux-state');
    fs.mkdirSync(fakeTmuxStateDir, { recursive: true });

    const port = await getFreePort();
    const timeoutMs = 1000;
    bridge = startBridge({
      port,
      jobsDir,
      omxCommand: createTmuxWaitOmxShim(tempDir),
      tmuxCommand: createFakeTmuxShim(tempDir),
      tmuxSessionsDir,
      allowedCwdPrefixes: tempDir,
      omxEnvAllowlist: 'PATH,FAKE_TMUX_STATE_DIR',
      bridgeEnv: {
        FAKE_TMUX_STATE_DIR: fakeTmuxStateDir,
        BRIDGE_JOB_TIMEOUT_MS: String(timeoutMs),
      },
    });
    await waitForBridge(port);

    const submit = await requestJson(port, 'POST', '/jobs', {
      prompt: 'runtime smoke tmux timeout',
      requestId: 'runtime-smoke-tmux-timeout',
      source: 'dispatch',
      sourceName: 'runtime-smoke-tmux-timeout',
      originRoutingKey: 'runtime-smoke:tmux-timeout',
      cwd: tempDir,
      executionMode: 'tmux',
      metadata: { smoke: 'tmux-timeout' },
    });
    const runningJob = await waitForRunningTmuxJob(port, submit.jobId);
    const sessionName = runningJob.session.sessionName;
    const tmuxPid = readFakeTmuxPid(fakeTmuxStateDir, sessionName);
    const job = await waitForNotifyOutcome(port, submit.jobId, 10_000);
    assert(job.status === 'failed', `tmux timeout job status was ${job.status}`);
    assert(job.session?.status === 'failed', `tmux timeout session status was ${job.session?.status}`);
    assert(job.session?.lastExitCode === null, `tmux timeout session lastExitCode was ${job.session?.lastExitCode}`);
    assert(job.exitCode === null, `tmux timeout exitCode was ${job.exitCode}`);
    assert(job.execution?.errorType === 'timeout', `tmux timeout errorType was ${job.execution?.errorType}`);
    assert(job.execution?.timedOut === true, 'tmux timeout did not record timedOut=true');
    assert(job.stderr.includes(`Command timed out after ${timeoutMs}ms`), `tmux timeout stderr was ${job.stderr || '<empty>'}`);
    await waitForFakeTmuxSessionCleanup(fakeTmuxStateDir, sessionName, tmuxPid);

    const sessionDir = path.join(tmuxSessionsDir, submit.jobId);
    assert(fs.existsSync(path.join(sessionDir, 'prompt.txt')), 'tmux timeout prompt file was not created');
    assert(fs.existsSync(path.join(sessionDir, 'run.sh')), 'tmux timeout runner script was not created');
    const sessionFile = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assert(sessionFile.status === 'failed', `tmux timeout session.json status was ${sessionFile.status}`);
    assert(sessionFile.lastExitCode === null, `tmux timeout session.json lastExitCode was ${sessionFile.lastExitCode}`);
  } catch (error) {
    failed = true;
    printSmokeDiagnostics('tmux session timeout smoke', tempDir, [bridge].filter(Boolean));
    throw error;
  } finally {
    await stopChild(bridge);
    cleanupTempDir(tempDir, failed);
  }
  log('tmux session timeout smoke passed');
}

async function smokeDispatchMcp() {
  const tempDir = makeTempDir('omx-bridge-smoke-dispatch-');
  let bridge;
  let client;
  let failed = false;
  try {
    const bridgePort = await getFreePort();
    const webhookPort = await getFreePort();
    bridge = startBridge({
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
    client = new Client({ name: 'runtime-smoke', version: '1.0.0' });
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
  } catch (error) {
    failed = true;
    printSmokeDiagnostics('omx-dispatch MCP health and submit-and-wait', tempDir, [bridge].filter(Boolean));
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
    await stopChild(bridge);
    cleanupTempDir(tempDir, failed);
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
  for (const tool of ['omx_submit_job', 'omx_get_job', 'omx_get_job_session', 'omx_list_jobs', 'omx_cancel_job']) {
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
  let bridge;
  let failed = false;
  try {
    const notify = await startNotifyServer();
    const port = await getFreePort();
    const omxCommand = fake ? createLiveOmxShim(tempDir) : resolveLiveOmxCommand();
    const { marker, prompt } = buildLiveOmxPrompt();
    const timeoutMs = getLiveOmxTimeoutMs();
    bridge = startBridge({
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
  } catch (error) {
    failed = true;
    printSmokeDiagnostics(`${fake ? 'fake ' : ''}live OMX exec smoke`, tempDir, [bridge].filter(Boolean));
    throw error;
  } finally {
    await stopChild(bridge, 7_000);
    cleanupTempDir(tempDir, failed);
  }
  log(`${fake ? 'fake ' : ''}live OMX exec smoke passed`);
}

async function smokeLoopbackRuntime() {
  assert(fs.existsSync(distMain), 'dist/main.js not found; run npm run build first');
  assert(fs.existsSync(dispatchMain), 'omx-dispatch/dist/index.js not found; run npm --prefix omx-dispatch run build first');
  await smokeDiagnosticsFixture();
  await smokeBridgeApi();
  await smokeCancelPath();
  await smokeTmuxRuntime();
  await smokeTmuxCancelRuntime();
  await smokeTmuxTimeoutRuntime();
  await smokeDispatchMcp();
  await smokeOpenClawPluginDiscovery();
  log('runtime smoke passed');
}

async function main() {
  const mode = process.argv[2] || '--loopback';
  if (mode === '--diagnostics-fixture-child') {
    emitDiagnosticsFixture();
    return;
  }
  assert(fs.existsSync(distMain), 'dist/main.js not found; run npm run build first');
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
