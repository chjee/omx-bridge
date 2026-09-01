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
const callbackSecret = 'runtime-smoke-callback-secret';
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

function captureFailureMessage(callback) {
  try {
    callback();
  } catch (error) {
    return String(error?.message ?? error);
  }
  fail('expected diagnostic assertion to fail');
}

function diagnosticValue(value, maxChars = 1_500) {
  let rendered;
  try {
    rendered = JSON.stringify(value, null, 2);
  } catch {
    rendered = String(value);
  }
  return truncateForDiagnostic(redactDiagnosticText(rendered), maxChars);
}

function assertEqual(actual, expected, message, context = undefined) {
  if (actual === expected) {
    return;
  }
  const details = {
    expected,
    actual,
    ...(context === undefined ? {} : { context }),
  };
  fail(`${message}: ${diagnosticValue(details)}`);
}

function assertIncludes(text, expected, message, context = undefined) {
  if (typeof text === 'string' && text.includes(expected)) {
    return;
  }
  const details = {
    expectedSubstring: expected,
    text: typeof text === 'string' ? text : `<${typeof text}>`,
    ...(context === undefined ? {} : { context }),
  };
  fail(`${message}: ${diagnosticValue(details, 2_500)}`);
}

function compactJobDiagnostic(job, options = {}) {
  if (!job || typeof job !== 'object') {
    return job;
  }
  return {
    ...(!options.omitCorrelation ? { id: job.id } : {}),
    status: job.status,
    executionMode: job.executionMode,
    source: job.source,
    sourceName: job.sourceName,
    ...(!options.omitCorrelation ? { originRoutingKey: job.originRoutingKey } : {}),
    notifyUrl: job.notifyUrl ? '<redacted>' : undefined,
    stdout: summarizeTextField(job.stdout),
    stderr: summarizeTextField(job.stderr),
    execution: executionSummary(job.execution),
    ...(!options.omitSession ? { session: job.session } : {}),
    notifyOutcome: notifyOutcomeSummary(job.notifyOutcome),
  };
}

function compactNotifyRequests(requests, options = {}) {
  return requests.map((request) => ({
    method: request.method,
    url: request.url ? redactDiagnosticText(request.url) : request.url,
    ...(!options.omitCorrelation ? { jobId: request.json?.id } : {}),
    status: request.json?.status,
    source: request.json?.source,
    sourceName: request.json?.sourceName,
    notifyUrl: request.json?.notifyUrl ? '<redacted>' : undefined,
  }));
}

function assertNotifyRequestReceived(requests, jobId, label, options = {}) {
  if (requests.some((request) => request.json?.id === jobId)) {
    return;
  }
  fail(`${label} callback was not received: ${diagnosticValue({
    ...(!options.omitCorrelation ? { expectedJobId: jobId } : {}),
    receivedRequests: compactNotifyRequests(requests, options),
  })}`);
}

function truncateForDiagnostic(value, maxChars = 4_000) {
  if (!value) {
    return '';
  }
  if (value.length <= maxChars) {
    return value;
  }
  let omitted = value.length - maxChars;
  let marker = `\n...<truncated ${omitted} chars>...\n`;
  let headLength = 0;
  let tailLength = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const contentBudget = Math.max(0, maxChars - marker.length);
    headLength = Math.min(1_000, Math.ceil(contentBudget * 0.8));
    tailLength = contentBudget - headLength;
    const nextOmitted = value.length - headLength - tailLength;
    if (nextOmitted === omitted) break;
    omitted = nextOmitted;
    marker = `\n...<truncated ${omitted} chars>...\n`;
  }
  return `${value.slice(0, headLength)}${marker}${tailLength > 0 ? value.slice(-tailLength) : ''}`;
}

function replaceDiagnosticLiteral(value, literal, replacement) {
  if (!literal) return value;
  return value.split(literal).join(replacement);
}

function redactDiagnosticText(value, options = {}) {
  if (!value) {
    return '';
  }
  const secretValues = [
    apiToken,
    callbackSecret,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    ...(options.literalSecrets ?? []),
  ].filter(Boolean);
  let redacted = String(value);
  for (const secret of secretValues) {
    redacted = replaceDiagnosticLiteral(redacted, secret, '<redacted>');
  }
  const privateRoots = [
    ['CODEX_HOME', process.env.CODEX_HOME],
    ['HOME', process.env.HOME],
  ]
    .filter(([, root]) => Boolean(root))
    .sort((left, right) => right[1].length - left[1].length);
  for (const [label, root] of privateRoots) {
    redacted = replaceDiagnosticLiteral(redacted, root, `<${label.toLowerCase()}>`);
  }
  if (options.omitCorrelation) {
    redacted = redacted
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<correlation>')
      .replace(/\bomx-bridge-[0-9a-f]{24}\b/gi, '<correlation>')
      .replace(/\bruntime-smoke-live-omx-\d+\b/gi, '<correlation>')
      .replace(/(["'](?:id|jobId|requestId|originRoutingKey|sessionName)["']\s*:\s*["'])[^"']*(["'])/gi, '$1<correlation>$2')
      .replace(/((?:jobId|requestId|originRoutingKey|sessionName)\s*[=:]\s*)[^\s,}]+/gi, '$1<correlation>');
  }
  return redacted
    .replace(/(["']authorization["']\s*:\s*["'])[^"']*(["'])/gi, '$1<redacted>$2')
    .replace(/(["'](?:api[_-]?key|token|secret|password|prompt)["']\s*:\s*["'])[^"']*(["'])/gi, '$1<redacted>$2')
    .replace(/(authorization\s*:\s*)[^\r\n]+/gi, '$1<redacted>')
    .replace(/(authorization\s*=\s*)[^,\r\n}]+/gi, '$1<redacted>')
    .replace(/(bearer\s+)[^\s"']+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|token|secret|password|authorization|prompt)\s*[=:]\s*)[^\s"',}]+/gi, '$1<redacted>')
    .replace(/([?&](?:api[_-]?key|token|secret|password|authorization)=)[^&\s"']+/gi, '$1<redacted>');
}

function safeFailureDiagnosticText(value, maxChars = 8_000, redactor = redactDiagnosticText) {
  try {
    return truncateForDiagnostic(redactor(value), maxChars);
  } catch {
    return '<failure diagnostics unavailable>';
  }
}

function compactWaitJobDiagnostic(job) {
  return diagnosticValue(
    compactJobDiagnostic(job, { omitCorrelation: true, omitSession: true }),
    1_200,
  );
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

function createTmuxHighOutputOmxShim(dir) {
  const filePath = path.join(dir, 'fake-omx-tmux-high-output.sh');
  writeExecutable(filePath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [ "${1-}" != "exec" ]; then',
    '  echo "unexpected omx command: ${1-}" >&2',
    '  exit 64',
    'fi',
    'cat > /dev/null',
    'printf "TMUX_CAP_STDOUT_HEAD"',
    'printf "x%.0s" $(seq 1 12000)',
    'printf "TMUX_CAP_STDOUT_TAIL"',
    'printf "TMUX_CAP_STDERR_HEAD" >&2',
    'printf "y%.0s" $(seq 1 12000) >&2',
    'printf "TMUX_CAP_STDERR_TAIL" >&2',
    ': > "${TMUX_CAPTURE_READY_FILE:?}"',
    'trap "exit 143" TERM INT',
    'while :; do',
    '  printf "z%.0s" $(seq 1 1024)',
    '  printf "TMUX_CAP_LIVE_STDOUT_TAIL"',
    '  printf "w%.0s" $(seq 1 1024) >&2',
    '  printf "TMUX_CAP_LIVE_STDERR_TAIL" >&2',
    '  sleep 0.02',
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
    '    if [ -n "$target" ] && [ -f "$state_dir/$target.running" ]; then exit 0; fi',
    '    echo "can\x27t find session: $target" >&2',
    '    exit 1',
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

function summarizeTextField(value, options = {}) {
  const text = value ?? '';
  const summary = {
    bytes: Buffer.byteLength(text),
    chars: text.length,
  };
  if ((verboseRuntimeSmokeDiagnostics || options.includePreview) && text) {
    try {
      summary.preview = truncateForDiagnostic(
        redactDiagnosticText(text, { literalSecrets: options.literalSecrets }),
        options.maxPreviewChars ?? 1_200,
      );
    } catch {
      summary.preview = '<preview unavailable>';
    }
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

function summarizeJobFile(filePath, options = {}) {
  try {
    const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!job || typeof job !== 'object' || !('status' in job)) {
      return null;
    }
    return {
      file: options.omitCorrelation ? '<job-state>' : redactDiagnosticText(filePath),
      ...(!options.omitCorrelation ? { id: job.id } : {}),
      status: job.status,
      ...(!options.omitCorrelation ? { requestId: job.requestId } : {}),
      source: job.source,
      sourceName: job.sourceName,
      ...(!options.omitCorrelation ? { originRoutingKey: job.originRoutingKey } : {}),
      cwd: redactDiagnosticText(job.cwd),
      notifyUrl: job.notifyUrl ? '<redacted>' : undefined,
      metadata: metadataSummary(job.metadata),
      stdout: summarizeTextField(job.stdout),
      stderr: summarizeTextField(job.stderr, {
        includePreview: options.includeStderrPreview,
        maxPreviewChars: 1_200,
        literalSecrets: [job.prompt].filter(Boolean),
      }),
      execution: executionSummary(job.execution),
      notifyOutcome: notifyOutcomeSummary(job.notifyOutcome),
    };
  } catch (error) {
    return {
      file: options.omitCorrelation ? '<job-state>' : redactDiagnosticText(filePath),
      unreadable: options.omitCorrelation
        ? '<job-state unreadable>'
        : safeFailureDiagnosticText(error, 1_200),
    };
  }
}

function summarizeJsonlFile(filePath, options = {}) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(-5);
    return {
      file: redactDiagnosticText(filePath),
      tail: lines.map((line) => {
        try {
          const event = JSON.parse(line);
          return {
            ...(!options.omitCorrelation ? { id: event?.job?.id ?? event?.id } : {}),
            status: event?.job?.status ?? event?.status,
            source: event?.job?.source ?? event?.source,
            sourceName: event?.job?.sourceName ?? event?.sourceName,
          };
        } catch {
          return options.omitCorrelation
            ? '<malformed-jsonl-entry>'
            : truncateForDiagnostic(redactDiagnosticText(line), 300);
        }
      }),
    };
  } catch (error) {
    return {
      file: redactDiagnosticText(filePath),
      unreadable: safeFailureDiagnosticText(error, 1_200),
    };
  }
}

function printSmokeDiagnostics(name, tempDir, bridges = [], options = {}) {
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
    .map((filePath) => summarizeJobFile(filePath, options))
    .filter(Boolean);
  if (jobSummaries.length > 0) {
    process.stderr.write(`[runtime-smoke] job json summaries:\n${JSON.stringify(jobSummaries, null, 2)}\n`);
  } else {
    process.stderr.write('[runtime-smoke] job json summaries: <none>\n');
  }

  const jsonlSummaries = listFilesRecursive(tempDir, (filePath) => filePath.endsWith('.jsonl'))
    .map((filePath) => summarizeJsonlFile(filePath, options));
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

  const equalityMessage = captureFailureMessage(() => {
    assertEqual('actual token=super-secret', 'expected', 'diagnostic equality fixture');
  });
  assert(equalityMessage.includes('"expected": "expected"'), 'diagnostic equality helper omitted expected value');
  assert(equalityMessage.includes('"actual": "actual token=<redacted>"'), 'diagnostic equality helper omitted redacted actual value');
  assert(!equalityMessage.includes('super-secret'), 'diagnostic equality helper leaked secret text');

  const includesMessage = captureFailureMessage(() => {
    assertIncludes('Status: unloaded', 'Status: loaded', 'OpenClaw plugin fixture');
  });
  assert(includesMessage.includes('"expectedSubstring": "Status: loaded"'), 'diagnostic include helper omitted expected substring');
  assert(includesMessage.includes('"text": "Status: unloaded"'), 'diagnostic include helper omitted actual text');

  const notifyMessage = captureFailureMessage(() => {
    assertNotifyRequestReceived(
      [{ method: 'POST', url: '/notify?token=super-secret', json: { id: 'other-job', notifyUrl: 'http://127.0.0.1:1/notify?token=super-secret' } }],
      'expected-job',
      'diagnostic notify fixture',
    );
  });
  assert(notifyMessage.includes('"expectedJobId": "expected-job"'), 'diagnostic notify helper omitted expected job id');
  assert(notifyMessage.includes('"jobId": "other-job"'), 'diagnostic notify helper omitted received request summary');
  assert(!notifyMessage.includes('super-secret'), 'diagnostic notify helper leaked secret text');

  const preservedMatch = result.stdout.match(/preserved failed runtime smoke temp dir: (.+)$/m);
  assert(preservedMatch, 'diagnostics fixture did not preserve the temp dir with KEEP_RUNTIME_SMOKE_DIR=1');
  fs.rmSync(preservedMatch[1], { recursive: true, force: true });

  const providerSecret = 'k7';
  const bearerSecret = 'fixture-bearer-credential';
  const basicAuthSecret = 'fixture-basic-credential';
  const assignedAuthSecret = 'fixture-assigned-auth-credential';
  const jsonAuthSecret = 'fixture-json-auth-credential';
  const jsonTokenSecret = 'fixture-json-token-credential';
  const jsonPasswordSecret = 'fixture-json-password-credential';
  const querySecret = 'fixture-query-credential';
  const promptSecret = 'fixture multiline prompt\nsecond confidential line';
  const malformedJsonlSecret = 'fixture-malformed-jsonl-secret';
  const malformedJsonlPrompt = 'fixture malformed jsonl prompt';
  const fixtureJobId = '00000000-0000-4000-a000-000000000077';
  const fixtureHome = process.env.HOME ?? path.join(os.tmpdir(), 'runtime-smoke-private-home');
  const fixtureCodexHome = path.join(fixtureHome, '.codex');
  const liveFailure = await runCommand(
    process.execPath,
    [__filename, '--live-failure-diagnostics-fixture-child'],
    {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: fixtureHome,
        CODEX_HOME: fixtureCodexHome,
        TMPDIR: os.tmpdir(),
        GOOGLE_API_KEY: providerSecret,
        KEEP_RUNTIME_SMOKE_DIR: '0',
        RUNTIME_SMOKE_DIAGNOSTICS_VERBOSE: '0',
      },
      timeoutMs: 10_000,
      allowNonZero: true,
    },
  );
  assert(liveFailure.code === 1, 'live failure fixture did not exercise main catch');
  assertIncludes(liveFailure.stderr, 'LIVE_FAILURE_STACK_MARKER', 'live failure fixture omitted safe stack marker');
  const summariesPrefix = '[runtime-smoke] job json summaries:\n';
  const summariesStart = liveFailure.stderr.indexOf(summariesPrefix);
  assert(summariesStart >= 0, 'live failure fixture did not print job summaries');
  const summariesJsonStart = summariesStart + summariesPrefix.length;
  const summariesEnd = liveFailure.stderr.indexOf('\n[runtime-smoke]', summariesJsonStart);
  const summariesJson = liveFailure.stderr.slice(
    summariesJsonStart,
    summariesEnd >= 0 ? summariesEnd : undefined,
  );
  const summaries = JSON.parse(summariesJson);
  const stderrPreview = summaries[0]?.stderr?.preview;
  assert(typeof stderrPreview === 'string', 'live failure fixture omitted stderr preview');
  assert(stderrPreview.length <= 1_200, 'live failure stderr preview exceeded 1,200 chars');
  assertIncludes(stderrPreview, 'LIVE_FAILURE_HEAD', 'live failure preview omitted stderr head');
  assertIncludes(stderrPreview, 'LIVE_FAILURE_TAIL', 'live failure preview omitted stderr tail');
  assertIncludes(stderrPreview, '...<truncated ', 'live failure preview omitted truncation evidence');
  assert(summaries[0]?.stdout?.preview === undefined, 'live failure fixture included stdout preview');
  for (const secret of [
    providerSecret,
    bearerSecret,
    basicAuthSecret,
    assignedAuthSecret,
    jsonAuthSecret,
    jsonTokenSecret,
    jsonPasswordSecret,
    querySecret,
  ]) {
    assert(!liveFailure.stderr.includes(secret), `live failure fixture leaked ${secret}`);
    assert(!stderrPreview.includes(secret), `live failure preview leaked ${secret}`);
  }
  assert(!stderrPreview.includes(promptSecret), 'live failure preview leaked multiline prompt');
  for (const promptLine of promptSecret.split('\n')) {
    assert(!liveFailure.stderr.includes(promptLine), 'live failure fixture leaked a prompt line');
  }
  const unreadableJobSummary = summarizeJobFile(
    path.join(fixtureHome, 'jobs', `${fixtureJobId}.json`),
    { omitCorrelation: true },
  );
  const unreadableJobDiagnostic = JSON.stringify(unreadableJobSummary);
  const waitFailureServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: fixtureJobId,
      requestId: `${fixtureJobId}:wait-request`,
      status: 'running',
      source: 'dispatch',
      sourceName: 'runtime-smoke-live',
      originRoutingKey: 'runtime-smoke:wait-routing',
      prompt: malformedJsonlPrompt,
      session: {
        sessionName: `omx-bridge-${fixtureJobId.replace(/-/g, '').slice(0, 24)}`,
        status: 'running',
      },
      stdout: '',
      stderr: '',
    }));
  });
  await new Promise((resolve, reject) => {
    waitFailureServer.once('error', reject);
    waitFailureServer.listen(0, '127.0.0.1', resolve);
  });
  const waitAddress = waitFailureServer.address();
  assert(waitAddress && typeof waitAddress === 'object', 'live wait fixture did not bind a local port');
  let waitFailureDiagnostic = '';
  try {
    await waitForNotifyOutcome(waitAddress.port, fixtureJobId, 25);
    fail('live wait fixture unexpectedly persisted a notify outcome');
  } catch (error) {
    waitFailureDiagnostic = safeFailureDiagnosticText(
      error.stack ?? error,
      8_000,
      (value) => redactDiagnosticText(value, { omitCorrelation: true }),
    );
  } finally {
    await new Promise((resolve) => waitFailureServer.close(resolve));
  }
  assertEqual(unreadableJobSummary?.file, '<job-state>', 'unreadable live job omitted safe file placeholder');
  assertEqual(
    unreadableJobSummary?.unreadable,
    '<job-state unreadable>',
    'unreadable live job omitted safe failure placeholder',
  );
  const leakedPathSignals = [
    ...(liveFailure.stderr.includes(fixtureJobId) ? ['job_file_uuid'] : []),
    ...(liveFailure.stderr.includes(fixtureHome) ? ['home_path'] : []),
    ...(liveFailure.stderr.includes(fixtureCodexHome) ? ['codex_home_path'] : []),
    ...(unreadableJobDiagnostic.includes(fixtureJobId) ? ['unreadable_job_uuid'] : []),
    ...(unreadableJobDiagnostic.includes(fixtureHome) ? ['unreadable_job_home_path'] : []),
    ...(liveFailure.stderr.includes(malformedJsonlSecret) ? ['malformed_jsonl_secret'] : []),
    ...(liveFailure.stderr.includes(malformedJsonlPrompt) ? ['malformed_jsonl_prompt'] : []),
    ...(waitFailureDiagnostic.includes(fixtureJobId) ? ['wait_error_uuid'] : []),
    ...(waitFailureDiagnostic.includes(`${fixtureJobId}:wait-request`) ? ['wait_error_request'] : []),
    ...(waitFailureDiagnostic.includes('runtime-smoke:wait-routing') ? ['wait_error_routing'] : []),
    ...(waitFailureDiagnostic.includes('omx-bridge-0000000000004000a0000000') ? ['wait_error_session'] : []),
    ...(waitFailureDiagnostic.includes(malformedJsonlPrompt) ? ['wait_error_prompt'] : []),
  ];
  assert(
    leakedPathSignals.length === 0,
    `live failure fixture leaked path/correlation signals: ${leakedPathSignals.join(',')}`,
  );
  assertIncludes(liveFailure.stderr, '<job-state>', 'live failure fixture omitted safe job-state placeholder');
  assertIncludes(liveFailure.stderr, 'scripts/runtime-smoke.js', 'live failure fixture omitted safe source-relative stack evidence');
  assert(summaries[0]?.id === undefined, 'live failure fixture included job id');
  assert(summaries[0]?.requestId === undefined, 'live failure fixture included request id');
  assert(summaries[0]?.originRoutingKey === undefined, 'live failure fixture included routing key');
  const jsonlPrefix = '[runtime-smoke] jsonl summaries:\n';
  const jsonlStart = liveFailure.stderr.indexOf(jsonlPrefix);
  assert(jsonlStart >= 0, 'live failure fixture omitted jsonl summaries');
  const jsonlJsonStart = jsonlStart + jsonlPrefix.length;
  const jsonlEnd = liveFailure.stderr.indexOf('\n[runtime-smoke]', jsonlJsonStart);
  const jsonlSummaries = JSON.parse(liveFailure.stderr.slice(
    jsonlJsonStart,
    jsonlEnd >= 0 ? jsonlEnd : undefined,
  ));
  assert(jsonlSummaries[0]?.tail?.[0]?.id === undefined, 'live failure jsonl summary included job id');
  assertEqual(
    jsonlSummaries[0]?.tail?.[1],
    '<malformed-jsonl-entry>',
    'live failure jsonl summary included a raw malformed entry',
  );
  assert(!liveFailure.stderr.includes('live-failure-jsonl-correlation'), 'live failure output leaked jsonl correlation');
  const compactLiveFailure = compactJobDiagnostic({
    id: 'fixture-job-id',
    originRoutingKey: 'fixture-routing-key',
    session: { sessionName: 'fixture-session-name' },
    status: 'failed',
  }, { omitCorrelation: true, omitSession: true });
  assert(compactLiveFailure.id === undefined, 'live assertion context included job id');
  assert(compactLiveFailure.originRoutingKey === undefined, 'live assertion context included routing key');
  assert(compactLiveFailure.session === undefined, 'live assertion context included session');
  const compactNotifyFailure = captureFailureMessage(() => {
    assertNotifyRequestReceived(
      [{ method: 'POST', url: '/notify', json: { id: 'fixture-received-job-id' } }],
      'fixture-expected-job-id',
      'live notify fixture',
      { omitCorrelation: true },
    );
  });
  assert(!compactNotifyFailure.includes('fixture-expected-job-id'), 'live notify assertion included expected job id');
  assert(!compactNotifyFailure.includes('fixture-received-job-id'), 'live notify assertion included received job id');
  const liveTempMatch = liveFailure.stderr.match(/\[runtime-smoke\] tempDir: (.+)$/m);
  assert(liveTempMatch, 'live failure fixture omitted temp directory evidence');
  assert(!fs.existsSync(liveTempMatch[1]), 'live failure fixture did not clean its temp directory');
  const safeFallback = safeFailureDiagnosticText(
    'RAW_FAILURE_FALLBACK_MARKER',
    1_200,
    () => { throw new Error('redactor failed'); },
  );
  assertEqual(
    safeFallback,
    '<failure diagnostics unavailable>',
    'failure diagnostic redaction did not use the safe fallback',
  );
  assert(!safeFallback.includes('RAW_FAILURE_FALLBACK_MARKER'), 'failure diagnostic fallback exposed raw text');
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

function emitLiveFailureDiagnosticsFixture() {
  const tempDir = makeTempDir('omx-bridge-live-failure-diagnostics-');
  const jobsDir = path.join(tempDir, 'jobs');
  const providerSecret = process.env.GOOGLE_API_KEY ?? 'k7';
  const fixtureHome = process.env.HOME ?? path.join(tempDir, 'home');
  const fixtureCodexHome = process.env.CODEX_HOME ?? path.join(fixtureHome, '.codex');
  const fixtureJobId = '00000000-0000-4000-a000-000000000077';
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${fixtureJobId}.json`), JSON.stringify({
    id: fixtureJobId,
    requestId: `${fixtureJobId}:request`,
    status: 'failed',
    source: 'dispatch',
    sourceName: 'runtime-smoke-live',
    originRoutingKey: 'runtime-smoke:live',
    cwd: path.join(fixtureHome, 'workspace'),
    prompt: 'fixture multiline prompt\nsecond confidential line',
    stdout: 'STDOUT_SHOULD_NOT_PREVIEW',
    stderr: [
      'LIVE_FAILURE_HEAD',
      `provider=${providerSecret}`,
      'Authorization: Bearer fixture-bearer-credential',
      'Authorization: Basic fixture-basic-credential',
      'Authorization=Basic fixture-assigned-auth-credential',
      '{"authorization":"Basic fixture-json-auth-credential"}',
      '{"token":"fixture-json-token-credential"}',
      '{"password":"fixture-json-password-credential"}',
      'url=https://127.0.0.1/failure?token=fixture-query-credential',
      `home=${fixtureHome}`,
      `codex_home=${fixtureCodexHome}`,
      'provider echoed input without a label:',
      'fixture multiline prompt\nsecond confidential line',
      apiToken,
      callbackSecret,
      'x'.repeat(3_000),
      'LIVE_FAILURE_TAIL',
    ].join('\n'),
    execution: {
      command: 'omx',
      exitCode: 1,
      errorType: 'non_zero_exit',
      durationMs: 12,
      timedOut: false,
    },
  }));
  fs.writeFileSync(path.join(tempDir, 'notifications.jsonl'), `${JSON.stringify({
    id: 'live-failure-jsonl-correlation',
    status: 'failed',
    source: 'dispatch',
  })}\nnot-json id=${fixtureJobId} home=${fixtureHome} codex=${fixtureCodexHome} `
    + `token=fixture-malformed-jsonl-secret prompt=fixture malformed jsonl prompt\n`);
  printSmokeDiagnostics('live failure diagnostics fixture', tempDir, [], {
    includeStderrPreview: true,
    omitCorrelation: true,
  });
  cleanupTempDir(tempDir, true);
  throw new Error(
    `LIVE_FAILURE_STACK_MARKER home=${path.join(fixtureHome, 'workspace', 'runtime-smoke.js')} `
      + `codex=${path.join(fixtureCodexHome, 'runtime', 'session.json')}`,
  );
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

function createDirectExecTreeShim(dir) {
  const filePath = path.join(dir, 'fake-omx-process-tree.js');
  const ignoringDescendant = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    "fs.writeFileSync(process.env.OMX_PROCESS_TREE_PID_FILE, process.ppid + ':' + process.pid + '\\n', { mode: 0o600 });",
    'setInterval(() => {}, 1000);',
  ].join('');
  writeExecutable(filePath, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const { spawn } = require('node:child_process');",
    'const pidFile = process.env.OMX_PROCESS_TREE_PID_FILE;',
    "if (!pidFile) { process.stderr.write('missing OMX_PROCESS_TREE_PID_FILE\\n'); process.exit(64); }",
    "const ignoreTerm = process.env.OMX_PROCESS_TREE_IGNORE_TERM === '1';",
    `const descendantSource = ${JSON.stringify(ignoringDescendant)};`,
    "const descendant = spawn(process.execPath, ['-e', descendantSource], { stdio: 'ignore' });",
    "if (ignoreTerm) process.on('SIGTERM', () => {});",
    "descendant.once('exit', (code) => process.exit(code ?? 0));",
    'setInterval(() => {}, 1000);',
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
      BRIDGE_CALLBACK_SECRET: callbackSecret,
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
      ...bridgeEnv,
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
    const safeRoute = redactDiagnosticText(route, { omitCorrelation: true });
    throw new Error(
      `${method} ${safeRoute} failed (${response.status}); responseBytes=${Buffer.byteLength(text)}`,
    );
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
  throw new Error(`job did not reach a terminal state; latest=${compactWaitJobDiagnostic(latest)}`);
}

async function waitForPathState(filePath, exists, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) === exists) return;
    await delay(50);
  }
  throw new Error(`path ${filePath} did not become ${exists ? 'present' : 'absent'}`);
}

async function waitForCappedArtifacts(paths, capBytes, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let previous = null;
  while (Date.now() < deadline) {
    if (!paths.every((filePath) => fs.existsSync(filePath))) {
      await delay(50);
      continue;
    }
    const sizes = paths.map((filePath) => fs.statSync(filePath).size);
    if (sizes.some((size) => size > capBytes) || sizes[0] + sizes[2] > capBytes || sizes[1] + sizes[3] > capBytes) {
      throw new Error(`tmux live capture exceeded cap ${capBytes}: ${sizes.join(',')}`);
    }
    if (previous && sizes.every((size, index) => size === previous[index])) {
      stable += 1;
      if (stable >= 2) return sizes;
    } else {
      stable = 0;
    }
    previous = sizes;
    await delay(50);
  }
  throw new Error(`tmux live capture did not become bounded within ${timeoutMs}ms`);
}

async function waitForLiveCaptureMetadata(filePath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const metadata = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (metadata?.stdout?.truncated && metadata?.stderr?.truncated && metadata.stdout.finalized === false && metadata.stderr.finalized === false) {
        return metadata;
      }
    } catch {
      // The wrapper replaces this small metadata file while its streams drain.
    }
    await delay(50);
  }
  throw new Error(`tmux live capture metadata did not report active truncation within ${timeoutMs}ms`);
}

function readLiveCaptureTail(filePath, capture) {
  const raw = fs.readFileSync(filePath);
  const { tailStart, tailLength } = capture;
  if (!Number.isSafeInteger(tailStart) || !Number.isSafeInteger(tailLength) || tailStart < 0 || tailLength < 0 || tailStart >= raw.length || tailLength > raw.length) {
    throw new Error('tmux live capture tail metadata is invalid');
  }
  const end = tailStart + tailLength;
  return Buffer.concat(end <= raw.length
    ? [raw.subarray(tailStart, end)]
    : [raw.subarray(tailStart), raw.subarray(0, end - raw.length)]).toString('utf8');
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
      throw new Error(`job became terminal before cancel: ${latest.status}`);
    }
    await delay(100);
  }
  throw new Error(`job did not enter running state; latest=${compactWaitJobDiagnostic(latest)}`);
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
      throw new Error(`tmux job became terminal before session was running: ${latest.status}`);
    }
    await delay(100);
  }
  throw new Error(
    `tmux job did not enter running session state; latest=${compactWaitJobDiagnostic(latest)}`,
  );
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

function isOwnedProcessAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform === 'linux') {
    try {
      return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function readOwnedProcessTree(pidFile) {
  const raw = fs.readFileSync(pidFile, 'utf8').trim();
  const [parent, descendant] = raw.split(':').map((value) => Number.parseInt(value, 10));
  assert(Number.isInteger(parent) && parent > 1, `owned process-tree parent pid was invalid: ${raw}`);
  assert(Number.isInteger(descendant) && descendant > 1, `owned process-tree descendant pid was invalid: ${raw}`);
  assert(parent !== process.pid && descendant !== process.pid, 'owned process-tree fixture resolved to the smoke runner');
  return { parent, descendant };
}

async function waitForOwnedProcessTreeExit(tree, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isOwnedProcessAlive(tree.parent) && !isOwnedProcessAlive(tree.descendant)) return;
    await delay(50);
  }
  throw new Error(`owned process tree did not exit: parent=${tree.parent}, descendant=${tree.descendant}`);
}

async function cleanupOwnedProcessTree(tree) {
  if (!tree) return;
  if (!isOwnedProcessAlive(tree.parent) && !isOwnedProcessAlive(tree.descendant)) return;
  try {
    process.kill(-tree.parent, 'SIGKILL');
  } catch (error) {
    if (!error || error.code !== 'ESRCH') throw error;
  }
  await waitForOwnedProcessTreeExit(tree);
}

async function forceStopChild(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child ${child.pid} did not exit after SIGKILL`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGKILL');
  });
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
  throw new Error(`job did not persist notifyOutcome; latest=${compactWaitJobDiagnostic(latest)}`);
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
        if (code !== 0 && !options.allowNonZero) {
          reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
          return;
        }
        resolve({ stdout, stderr, code });
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
    assertEqual(dispatchJob.status, 'succeeded', 'dispatch job status mismatch', compactJobDiagnostic(dispatchJob));
    assertEqual(dispatchJob.stdout, 'OK\n', 'dispatch job stdout mismatch', compactJobDiagnostic(dispatchJob));
    assertEqual(dispatchJob.originRoutingKey, 'telegram:direct:123', 'dispatch originRoutingKey was not preserved', compactJobDiagnostic(dispatchJob));
    assertEqual(dispatchJob.sourceName, 'omx-dispatch', 'dispatch sourceName was not preserved', compactJobDiagnostic(dispatchJob));
    assertEqual(dispatchJob.metadata?.smoke, 'runtime', 'dispatch metadata was not preserved', compactJobDiagnostic(dispatchJob));
    assertEqual(dispatchJob.notifyOutcome?.claudeWebhook?.status, 'ok', 'per-job notifyUrl did not report ok', compactJobDiagnostic(dispatchJob));
    assertEqual(dispatchJob.notifyOutcome?.telegram?.skippedReason, 'webhook_ok', 'telegram was not skipped after webhook ok', compactJobDiagnostic(dispatchJob));
    assertNotifyRequestReceived(notify.requests, dispatchSubmit.jobId, 'dispatch notifyUrl');

    const openclawSubmit = await requestJson(port, 'POST', '/jobs', {
      prompt: 'runtime smoke openclaw fields',
      requestId: 'runtime-smoke-openclaw-fields',
      source: 'openclaw',
      sourceName: 'openclaw-telegram',
      originRoutingKey: 'telegram:direct:456',
      metadata: { channel: 'openclaw' },
    });
    const openclawJob = await waitForNotifyOutcome(port, openclawSubmit.jobId);
    assertEqual(openclawJob.status, 'succeeded', 'openclaw job status mismatch', compactJobDiagnostic(openclawJob));
    assertEqual(openclawJob.source, 'openclaw', 'openclaw source was not preserved', compactJobDiagnostic(openclawJob));
    assertEqual(openclawJob.sourceName, 'openclaw-telegram', 'openclaw sourceName was not preserved', compactJobDiagnostic(openclawJob));
    assertEqual(openclawJob.originRoutingKey, 'telegram:direct:456', 'openclaw originRoutingKey was not preserved', compactJobDiagnostic(openclawJob));
    assertEqual(openclawJob.metadata?.channel, 'openclaw', 'openclaw metadata was not preserved', compactJobDiagnostic(openclawJob));
    assertEqual(openclawJob.notifyOutcome?.claudeWebhook?.skippedReason, 'no_notify_url', 'missing CLAUDE_NOTIFY_URL was not recorded', compactJobDiagnostic(openclawJob));
    assertEqual(openclawJob.notifyOutcome?.telegram?.skippedReason, 'not_configured', 'unconfigured Telegram fallback was not recorded', compactJobDiagnostic(openclawJob));
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

async function smokeDirectExecContainment() {
  if (process.platform === 'win32') {
    log('direct exec process-tree containment smoke skipped on Windows');
    return;
  }

  const tempDir = makeTempDir('omx-bridge-smoke-exec-containment-');
  const ownedTrees = [];
  const bridges = [];
  let failed = false;
  const treeCommand = createDirectExecTreeShim(tempDir);

  const startTreeJob = async (label, { ignoreTerm = false, timeoutMs = 10_000 } = {}) => {
    const pidFile = path.join(tempDir, `${label}.pids`);
    const port = await getFreePort();
    const bridge = startBridge({
      port,
      jobsDir: path.join(tempDir, `${label}-jobs`),
      omxCommand: treeCommand,
      omxEnvAllowlist: 'PATH,OMX_PROCESS_TREE_PID_FILE,OMX_PROCESS_TREE_IGNORE_TERM',
      bridgeEnv: {
        OMX_PROCESS_TREE_PID_FILE: pidFile,
        OMX_PROCESS_TREE_IGNORE_TERM: ignoreTerm ? '1' : '0',
        BRIDGE_JOB_TIMEOUT_MS: String(timeoutMs),
        BRIDGE_SIGKILL_GRACE_MS: '50',
      },
    });
    bridges.push(bridge);
    await waitForBridge(port);
    const submit = await requestJson(port, 'POST', '/jobs', {
      prompt: `runtime smoke direct exec ${label}`,
      requestId: `runtime-smoke-direct-exec-${label}`,
      source: 'dispatch',
    });
    await waitForRunningJob(port, submit.jobId);
    await waitForPathState(pidFile, true);
    const tree = readOwnedProcessTree(pidFile);
    ownedTrees.push(tree);
    return { bridge, port, jobId: submit.jobId, tree };
  };

  try {
    const cancelled = await startTreeJob('cancel');
    await requestJson(cancelled.port, 'POST', `/jobs/${encodeURIComponent(cancelled.jobId)}/cancel`);
    await waitForTerminalJob(cancelled.port, cancelled.jobId);
    await waitForOwnedProcessTreeExit(cancelled.tree);

    const timedOut = await startTreeJob('timeout', { ignoreTerm: true, timeoutMs: 1_000 });
    const timeoutJob = await waitForTerminalJob(timedOut.port, timedOut.jobId);
    assertEqual(timeoutJob.execution?.errorType, 'timeout', 'direct exec tree did not time out', compactJobDiagnostic(timeoutJob));
    await waitForOwnedProcessTreeExit(timedOut.tree);

    const graceful = await startTreeJob('graceful');
    await stopChild(graceful.bridge, 5_000);
    await waitForOwnedProcessTreeExit(graceful.tree);

    const forced = await startTreeJob('forced');
    await forceStopChild(forced.bridge);
    const forcedTreeSurvived = isOwnedProcessAlive(forced.tree.parent) || isOwnedProcessAlive(forced.tree.descendant);
    log(`non-systemd forced bridge termination diagnostic: owned descendant survived=${forcedTreeSurvived}`);
    await cleanupOwnedProcessTree(forced.tree);
  } catch (error) {
    failed = true;
    printSmokeDiagnostics('direct exec process-tree containment', tempDir, bridges);
    throw error;
  } finally {
    const teardownResults = await Promise.allSettled([
      ...ownedTrees.map((tree) => cleanupOwnedProcessTree(tree)),
      ...bridges.map((bridge) => stopChild(bridge, 5_000)),
    ]);
    const teardownFailure = teardownResults.find((result) => result.status === 'rejected');
    cleanupTempDir(tempDir, failed);
    if (teardownFailure?.status === 'rejected') throw teardownFailure.reason;
  }
  log('direct exec process-tree containment smoke passed');
}

async function smokeTmuxRuntime() {
  const tempDir = makeTempDir('omx-bridge-smoke-tmux-');
  let bridge;
  let liveProbe;
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
        BRIDGE_MAX_TERMINAL_JOBS: '1',
        BRIDGE_JOB_CLEANUP_INTERVAL_MS: '100',
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
    assertEqual(job.status, 'succeeded', 'tmux job status mismatch', compactJobDiagnostic(job));
    assertEqual(job.executionMode, 'tmux', 'tmux job did not preserve executionMode', compactJobDiagnostic(job));
    assertIncludes(job.stdout, 'TMUX_OK:runtime smoke tmux', 'tmux job stdout was not captured', compactJobDiagnostic(job));
    assertEqual(job.session?.backend, 'tmux', 'tmux session backend mismatch', compactJobDiagnostic(job));
    assertEqual(job.session?.status, 'exited', 'tmux persisted session status mismatch', compactJobDiagnostic(job));
    assertEqual(job.session?.lastExitCode, 0, 'tmux persisted session lastExitCode mismatch', compactJobDiagnostic(job));
    assertIncludes(job.session?.attachCommand, 'attach -t', 'tmux attachCommand was not persisted', compactJobDiagnostic(job));

    const sessionDir = path.join(tmuxSessionsDir, submit.jobId);
    assert(fs.existsSync(path.join(sessionDir, 'prompt.txt')), `tmux prompt file was not created in ${sessionDir}`);
    assert(fs.existsSync(path.join(sessionDir, 'run.sh')), `tmux runner script was not created in ${sessionDir}`);
    assert(fs.existsSync(path.join(sessionDir, 'session.json')), `tmux session file was not created in ${sessionDir}`);
    assert(fs.existsSync(path.join(sessionDir, 'exit-code')), `tmux exit-code file was not created in ${sessionDir}`);
    assertEqual(fs.readFileSync(path.join(sessionDir, 'prompt.txt'), 'utf8'), 'runtime smoke tmux', 'tmux prompt file did not preserve prompt', { sessionDir });
    assertEqual(fs.readFileSync(path.join(sessionDir, 'exit-code'), 'utf8').trim(), '0', 'tmux exit-code file was not zero', { sessionDir });
    const sessionFile = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assertEqual(sessionFile.status, 'exited', 'tmux session.json status mismatch', { sessionDir, sessionFile });

    const retainedSubmit = await requestJson(port, 'POST', '/jobs', {
      prompt: 'runtime smoke tmux retained',
      requestId: 'runtime-smoke-tmux-retained',
      source: 'dispatch',
      cwd: tempDir,
      executionMode: 'tmux',
    });
    const retainedJob = await waitForTerminalJob(port, retainedSubmit.jobId, 10_000);
    assertEqual(retainedJob.status, 'succeeded', 'retained tmux job status mismatch', compactJobDiagnostic(retainedJob));
    const retainedSessionDir = path.join(tmuxSessionsDir, retainedSubmit.jobId);
    await waitForPathState(sessionDir, false);
    assert(fs.existsSync(retainedSessionDir), 'latest retained tmux session directory was removed');
    assert(fs.existsSync(path.join(retainedSessionDir, 'session.json')), 'latest retained session state was removed');

    const liveId = '90000000-0000-4000-a000-000000000099';
    const liveSessionName = `omx-bridge-${liveId.replace(/-/g, '').slice(0, 24)}`;
    const liveSessionDir = path.join(tmuxSessionsDir, liveId);
    fs.mkdirSync(liveSessionDir, { recursive: true });
    fs.writeFileSync(path.join(liveSessionDir, 'session.json'), JSON.stringify({ sessionName: liveSessionName }));
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(liveSessionDir, oldTime, oldTime);
    fs.utimesSync(path.join(liveSessionDir, 'session.json'), oldTime, oldTime);
    liveProbe = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    children.push(liveProbe);
    fs.writeFileSync(path.join(fakeTmuxStateDir, `${liveSessionName}.running`), '');
    fs.writeFileSync(path.join(fakeTmuxStateDir, `${liveSessionName}.pid`), `${liveProbe.pid}\n`);
    const inactiveSentinelId = '80000000-0000-4000-a000-000000000098';
    const inactiveSentinelName = `omx-bridge-${inactiveSentinelId.replace(/-/g, '').slice(0, 24)}`;
    const inactiveSentinelDir = path.join(tmuxSessionsDir, inactiveSentinelId);
    fs.mkdirSync(inactiveSentinelDir, { recursive: true });
    fs.writeFileSync(path.join(inactiveSentinelDir, 'session.json'), JSON.stringify({
      sessionName: inactiveSentinelName,
    }));
    fs.utimesSync(inactiveSentinelDir, oldTime, oldTime);
    fs.utimesSync(path.join(inactiveSentinelDir, 'session.json'), oldTime, oldTime);
    await waitForPathState(inactiveSentinelDir, false);
    assert(fs.existsSync(liveSessionDir), 'live orphan tmux session directory was removed');
    assert(liveProbe.pid && isProcessGroupAlive(liveProbe.pid), 'live retention probe process was terminated');
  } catch (error) {
    failed = true;
    printSmokeDiagnostics('tmux session runtime smoke', tempDir, [bridge].filter(Boolean));
    throw error;
  } finally {
    await stopChild(liveProbe);
    await stopChild(bridge);
    cleanupTempDir(tempDir, failed);
  }
  log('tmux session runtime smoke passed');
}

async function smokeTmuxLiveOutputCapRuntime() {
  const tempDir = makeTempDir('omx-bridge-smoke-tmux-cap-');
  let bridge;
  let failed = false;
  try {
    const jobsDir = path.join(tempDir, 'jobs');
    const tmuxSessionsDir = path.join(tempDir, 'sessions');
    const fakeTmuxStateDir = path.join(tempDir, 'fake-tmux-state');
    const readyFile = path.join(tempDir, 'capture-ready');
    const capBytes = 4096;
    fs.mkdirSync(fakeTmuxStateDir, { recursive: true });
    const port = await getFreePort();
    bridge = startBridge({
      port,
      jobsDir,
      omxCommand: createTmuxHighOutputOmxShim(tempDir),
      tmuxCommand: createFakeTmuxShim(tempDir),
      tmuxSessionsDir,
      allowedCwdPrefixes: tempDir,
      omxEnvAllowlist: 'PATH,FAKE_TMUX_STATE_DIR,TMUX_CAPTURE_READY_FILE',
      bridgeEnv: {
        FAKE_TMUX_STATE_DIR: fakeTmuxStateDir,
        TMUX_CAPTURE_READY_FILE: readyFile,
        BRIDGE_TMUX_MAX_CAPTURE_BYTES_PER_STREAM: String(capBytes),
        BRIDGE_JOB_POLL_INTERVAL_MS: '10000',
      },
    });
    await waitForBridge(port);
    const submit = await requestJson(port, 'POST', '/jobs', {
      prompt: 'runtime smoke tmux live cap',
      requestId: 'runtime-smoke-tmux-live-cap',
      source: 'dispatch',
      cwd: tempDir,
      executionMode: 'tmux',
    });
    const runningJob = await waitForRunningTmuxJob(port, submit.jobId);
    await waitForPathState(readyFile, true);
    const sessionDir = path.join(tmuxSessionsDir, submit.jobId);
    await waitForCappedArtifacts([
      path.join(sessionDir, 'stdout.log'),
      path.join(sessionDir, 'stderr.log'),
      path.join(sessionDir, 'stdout.tail'),
      path.join(sessionDir, 'stderr.tail'),
    ], capBytes);
    const capture = await waitForLiveCaptureMetadata(path.join(sessionDir, 'capture.json'));
    const liveStdout = fs.readFileSync(path.join(sessionDir, 'stdout.log'), 'utf8');
    const liveStderr = fs.readFileSync(path.join(sessionDir, 'stderr.log'), 'utf8');
    const liveStdoutTail = readLiveCaptureTail(path.join(sessionDir, 'stdout.tail'), capture.stdout);
    const liveStderrTail = readLiveCaptureTail(path.join(sessionDir, 'stderr.tail'), capture.stderr);
    assertIncludes(liveStdout, 'TMUX_CAP_STDOUT_HEAD', 'tmux live cap stdout lost head');
    assertIncludes(liveStdoutTail, 'TMUX_CAP_LIVE_STDOUT_TAIL', 'tmux live cap stdout lost latest tail');
    assertIncludes(liveStderr, 'TMUX_CAP_STDERR_HEAD', 'tmux live cap stderr lost head');
    assertIncludes(liveStderrTail, 'TMUX_CAP_LIVE_STDERR_TAIL', 'tmux live cap stderr lost latest tail');
    const sessionName = runningJob.session.sessionName;
    const tmuxPid = readFakeTmuxPid(fakeTmuxStateDir, sessionName);
    const cancelResponse = await requestJson(port, 'POST', `/jobs/${encodeURIComponent(submit.jobId)}/cancel`);
    assertEqual(cancelResponse.status, 'cancelled', 'tmux live cap cancel status mismatch', compactJobDiagnostic(cancelResponse));
    await waitForFakeTmuxSessionCleanup(fakeTmuxStateDir, sessionName, tmuxPid);
    const cancelled = await waitForNotifyOutcome(port, submit.jobId);
    assertEqual(cancelled.status, 'cancelled', 'tmux live cap job status mismatch', compactJobDiagnostic(cancelled));
  } catch (error) {
    failed = true;
    printSmokeDiagnostics('tmux live output cap runtime smoke', tempDir, [bridge].filter(Boolean));
    throw error;
  } finally {
    await stopChild(bridge);
    cleanupTempDir(tempDir, failed);
  }
  log('tmux live output cap runtime smoke passed');
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
        // The cancellation request owns this fixture's terminal write. Keep
        // the periodic collector out of the fake tmux teardown window.
        BRIDGE_JOB_POLL_INTERVAL_MS: '10000',
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
    assertEqual(cancelResponse.status, 'cancelled', 'tmux cancel response status mismatch', compactJobDiagnostic(cancelResponse));
    assertEqual(cancelResponse.session?.status, 'cancelled', 'tmux cancel response session status mismatch', compactJobDiagnostic(cancelResponse));
    assertEqual(cancelResponse.execution?.errorType, 'cancelled', 'tmux cancel response did not record errorType=cancelled', compactJobDiagnostic(cancelResponse));
    await waitForFakeTmuxSessionCleanup(fakeTmuxStateDir, sessionName, tmuxPid);

    const cancelledJob = await waitForNotifyOutcome(port, submit.jobId);
    assertEqual(cancelledJob.status, 'cancelled', 'tmux cancelled job status mismatch', compactJobDiagnostic(cancelledJob));
    assertEqual(cancelledJob.session?.status, 'cancelled', 'tmux cancelled persisted session status mismatch', compactJobDiagnostic(cancelledJob));
    assertEqual(cancelledJob.execution?.errorType, 'cancelled', 'tmux cancelled job did not record errorType=cancelled', compactJobDiagnostic(cancelledJob));

    const sessionDir = path.join(tmuxSessionsDir, submit.jobId);
    assert(fs.existsSync(path.join(sessionDir, 'prompt.txt')), `tmux cancel prompt file was not created in ${sessionDir}`);
    assert(fs.existsSync(path.join(sessionDir, 'run.sh')), `tmux cancel runner script was not created in ${sessionDir}`);
    const sessionFile = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assertEqual(sessionFile.status, 'cancelled', 'tmux cancel session.json status mismatch', { sessionDir, sessionFile });
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
    assertEqual(job.status, 'failed', 'tmux timeout job status mismatch', compactJobDiagnostic(job));
    assertEqual(job.session?.status, 'failed', 'tmux timeout persisted session status mismatch', compactJobDiagnostic(job));
    assertEqual(job.session?.lastExitCode, null, 'tmux timeout persisted session lastExitCode mismatch', compactJobDiagnostic(job));
    assertEqual(job.exitCode, null, 'tmux timeout exitCode mismatch', compactJobDiagnostic(job));
    assertEqual(job.execution?.errorType, 'timeout', 'tmux timeout errorType mismatch', compactJobDiagnostic(job));
    assertEqual(job.execution?.timedOut, true, 'tmux timeout did not record timedOut=true', compactJobDiagnostic(job));
    assertIncludes(job.stderr, `Command timed out after ${timeoutMs}ms`, 'tmux timeout stderr mismatch', compactJobDiagnostic(job));
    await waitForFakeTmuxSessionCleanup(fakeTmuxStateDir, sessionName, tmuxPid);

    const sessionDir = path.join(tmuxSessionsDir, submit.jobId);
    assert(fs.existsSync(path.join(sessionDir, 'prompt.txt')), `tmux timeout prompt file was not created in ${sessionDir}`);
    assert(fs.existsSync(path.join(sessionDir, 'run.sh')), `tmux timeout runner script was not created in ${sessionDir}`);
    const sessionFile = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assertEqual(sessionFile.status, 'failed', 'tmux timeout session.json status mismatch', { sessionDir, sessionFile });
    assertEqual(sessionFile.lastExitCode, null, 'tmux timeout session.json lastExitCode mismatch', { sessionDir, sessionFile });
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
        BRIDGE_CALLBACK_SECRET: callbackSecret,
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
    assertEqual(wait.completed, true, 'omx_submit_job_and_wait did not complete', wait);
    assertEqual(wait.status, 'succeeded', 'dispatch wait status mismatch', wait);
    assertEqual(
      wait.notification?.job?.notifyUrl,
      `http://127.0.0.1:${webhookPort}/notify`,
      'dispatch MCP notifyUrl was not the session webhook',
      {
        webhookPort,
        wait: {
          completed: wait.completed,
          status: wait.status,
          notificationJob: compactJobDiagnostic(wait.notification?.job),
          job: compactJobDiagnostic(wait.job),
        },
      },
    );
    assertEqual(wait.job?.stdout, 'OK\n', 'dispatch MCP job stdout mismatch', compactJobDiagnostic(wait.job));
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
  assertIncludes(info.stdout, 'Status: loaded', 'OpenClaw plugin is not loaded', {
    command: openclawPath,
    stderr: info.stderr,
  });
  for (const tool of ['omx_submit_job', 'omx_get_job', 'omx_get_job_session', 'omx_list_jobs', 'omx_cancel_job']) {
    assertIncludes(info.stdout, tool, `OpenClaw plugin info did not include ${tool}`, {
      command: openclawPath,
      stderr: info.stderr,
    });
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
    const compactOptions = fake ? {} : { omitCorrelation: true, omitSession: true };
    assertEqual(job.status, 'succeeded', 'live OMX job status mismatch', compactJobDiagnostic(job, compactOptions));
    assertIncludes(job.stdout, marker, 'live OMX job output did not include expected marker', compactJobDiagnostic(job, compactOptions));
    assertEqual(job.execution?.command, omxCommand, 'live OMX job did not record the selected OMX command', compactJobDiagnostic(job, compactOptions));
    assertEqual(job.notifyOutcome?.claudeWebhook?.status, 'ok', 'live OMX notifyUrl did not report ok', compactJobDiagnostic(job, compactOptions));
    assertNotifyRequestReceived(
      notify.requests,
      submit.jobId,
      'live OMX notifyUrl',
      fake ? {} : { omitCorrelation: true },
    );
  } catch (error) {
    failed = true;
    printSmokeDiagnostics(
      `${fake ? 'fake ' : ''}live OMX exec smoke`,
      tempDir,
      [bridge].filter(Boolean),
      { includeStderrPreview: !fake, omitCorrelation: !fake },
    );
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
  await smokeDirectExecContainment();
  await smokeTmuxRuntime();
  await smokeTmuxLiveOutputCapRuntime();
  await smokeTmuxCancelRuntime();
  await smokeTmuxTimeoutRuntime();
  await smokeDispatchMcp();
  await smokeOpenClawPluginDiscovery();
  log('runtime smoke passed');
}

async function flushOutputStreams() {
  await Promise.all([
    new Promise((resolve) => process.stdout.write('', resolve)),
    new Promise((resolve) => process.stderr.write('', resolve)),
  ]);
}

async function main() {
  const mode = process.argv[2] || '--loopback';
  if (mode === '--diagnostics-fixture-child') {
    emitDiagnosticsFixture();
    await flushOutputStreams();
    return;
  }
  if (mode === '--live-failure-diagnostics-fixture-child') {
    emitLiveFailureDiagnosticsFixture();
    await flushOutputStreams();
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
  process.stderr.write(`[runtime-smoke] failed: ${safeFailureDiagnosticText(
    error.stack ?? error,
    8_000,
    (value) => redactDiagnosticText(value, { omitCorrelation: true }),
  )}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await Promise.all(children.map((child) => stopChild(child)));
  await closeServers();
});
