# omx-bridge

OpenClaw and Claude Code bridge service for running OMX jobs from chat-driven coding sessions.

The bridge accepts job requests over HTTP, runs `omx exec`, stores job state on disk, and sends completion notifications back to the caller through OpenClaw, Telegram, or a Claude Code MCP webhook.

## When To Use This

If you are already at a terminal and only need to run a coding agent, use `omx` directly.

Use `omx-bridge` when you want Claude Code or Telegram resident sessions to delegate work to OMX and receive completion events back into the conversation. The bridge is not an `omx` CLI replacement; it is a coordination layer for asynchronous Claude/OMX workflows.

## Architecture

```text
Telegram / Claude Code CLI
  -> Claude Code session
  -> omx-dispatch tool server
  -> omx-bridge HTTP service
  -> omx exec
  -> completion webhook / fallback notification
```

Main components:

- `src/`: NestJS bridge service and file-backed job queue.
- `omx-dispatch/`: Claude Code MCP server exposing `omx_submit_job`, job status tools, and a local `/notify` webhook.
- `omx-bridge-plugin/`: OpenClaw plugin entry point.
- `contracts/bridge-job.contract.json`: shared bridge job/session payload fixture used to catch server, dispatch, and plugin contract drift.
- `.omx/state/bridge-jobs`: default job state directory.

Agent maintenance workflow is documented in [docs/agent-workflow.md](docs/agent-workflow.md).
Routing ownership is documented in [docs/routing-contract.md](docs/routing-contract.md).
Bridge contract source-of-truth options are documented in [docs/contract-source-of-truth.md](docs/contract-source-of-truth.md).
Runtime validation steps are documented in [docs/runtime-smoke.md](docs/runtime-smoke.md).
Release verification gates are summarized in [docs/release-verification.md](docs/release-verification.md).

When bridge job payload fields, session summary fields, status values, execution
error types, or routing fields change, update
`contracts/bridge-job.contract.json` in the same change. The fixture is exercised
by the root bridge contract test, `omx-dispatch` contract test, and OpenClaw
plugin tests so all three surfaces fail together when their contracts drift.

## Setup

Install dependencies:

```bash
npm install
cd omx-dispatch && npm install
cd ../omx-bridge-plugin && npm ci
```

Create local env files from the examples:

```bash
cp .env.example .env
cp omx-dispatch/.env.example omx-dispatch/.env
```

Run the bridge service in development:

```bash
npm run start:dev
```

Build all packages:

```bash
npm run build
cd omx-dispatch && npm run build
cd ../omx-bridge-plugin && npm run build
```

## Bridge Service Configuration

Important root `.env` values:

```env
PORT=3992
BRIDGE_HOST=127.0.0.1
BRIDGE_REQUEST_BODY_LIMIT=1mb
BRIDGE_JOBS_DIR=.omx/state/bridge-jobs
OMX_COMMAND=omx
NOTIFY_MODE=openclaw
```

Idempotent submissions:

- `requestId` is scoped by `source`. Repeating the same `source + requestId`
  with the same payload returns the existing job instead of creating another one.
- When `requestId` is present, the bridge stores a request fingerprint over the
  routing-sensitive payload (`prompt`, `cwd`, `notifyUrl`, `originRoutingKey`,
  `source`, `sourceName`, and stable `metadata`). Reusing the same `source +
  requestId` with a different payload is rejected with `409 Conflict`.

Request bodies are bounded by `BRIDGE_REQUEST_BODY_LIMIT` (default: `1mb`).
`metadata` is intended for small routing/context fields and must serialize to
8192 bytes or less.

Notification modes:

- `openclaw`: send OpenClaw hook notifications and direct Telegram notifications when configured.
- `claude`: POST job completion to a Claude webhook; Telegram settings provide fallback push.

Claude webhook URL resolution order (highest priority first):

1. **per-job `notifyUrl`** (sent by the caller in the job payload, e.g. `omx-dispatch` always supplies its own session-local webhook URL).
2. **`CLAUDE_NOTIFY_URL`** (configured fallback for callers that did not supply `notifyUrl`).

When a request comes from `omx-dispatch`, `CLAUDE_NOTIFY_URL` is effectively unused because `notifyUrl` is always present.

In claude notify mode, configured Telegram fallback behaviour depends on whether a per-job `notifyUrl` was supplied. This fallback sends to `TELEGRAM_NOTIFY_CHAT_ID`; it does not parse `originRoutingKey` for per-conversation delivery.

- **`notifyUrl` absent**: the configured Telegram target is used as a fallback when `CLAUDE_NOTIFY_URL` is not configured or its webhook cannot be delivered.
- **`notifyUrl` present**: Telegram fallback is skipped — the per-job URL takes full ownership of the callback. This keeps per-chat routing consistent when used with channel brokers such as `claude-chopper` or legacy `claude-synapse`. For `omx-dispatch`, a 2xx response from the session-local `/notify` endpoint means the bridge treats delivery as complete; if `ENABLE_CLAUDE_CHANNEL` is not enabled in the Claude Code MCP server environment, the completion is only queued for `omx_get_notifications` and will not wake the active CLI conversation.
- **`source: "channel"` with `originRoutingKey`**: Telegram fallback is also skipped when webhook delivery fails. `sourceName` carries the concrete broker name, e.g. `claude-chopper`.
- **`source: "openclaw"` with `originRoutingKey`**: the routing key is stored and returned for correlation, but it does not make the job broker-owned. Without a per-job `notifyUrl`, configured Telegram fallback still applies in `claude` notify mode.

Claude webhook delivery retries before fallback using `BRIDGE_NOTIFY_RETRY_DELAYS_MS`
(default: `500,1000,2000`, which means four total attempts). Each notification
fetch attempt is bounded by `BRIDGE_NOTIFY_TIMEOUT_MS` (default: `5000`); this is
separate from `BRIDGE_JOB_TIMEOUT_MS`.

On startup, the runner also reconciles retained terminal jobs whose completion
notification was never recorded, or whose latest notification attempt has no
successful channel and at least one failed channel. Terminal jobs whose channels
were only skipped, such as an intentionally unconfigured delivery target, are not
retried repeatedly.

For Claude mode:

```env
NOTIFY_MODE=claude
CLAUDE_NOTIFY_URL=http://127.0.0.1:<port>/notify  # omx-dispatch auto-assigns port in 12000-12999
BRIDGE_NOTIFY_RETRY_DELAYS_MS=500,1000,2000
BRIDGE_NOTIFY_TIMEOUT_MS=5000
BRIDGE_CALLBACK_SECRET=shared-secret
TELEGRAM_BOT_TOKEN=optional-fallback-token
TELEGRAM_NOTIFY_CHAT_ID=optional-fallback-chat-id
```

`BRIDGE_CALLBACK_SECRET` must match the MCP server env when webhook signature verification is enabled.

### Execution boundaries

The bridge runs requested work through `omx exec --full-auto -s danger-full-access -`
and writes the prompt to the child process stdin instead of passing it as an
argv value. Bind and working-directory settings are part of the safety boundary.

The `omx exec` child process receives only an environment-variable allowlist,
configured by `BRIDGE_OMX_ENV_ALLOWLIST`. By default this keeps common shell,
Codex/OMX, XDG, SSH agent, and model-provider variables, while excluding bridge
delivery secrets such as `BRIDGE_API_TOKEN`, `BRIDGE_CALLBACK_SECRET`,
`TELEGRAM_BOT_TOKEN`, and `OPENCLAW_HOOKS_TOKEN`. Add any required local runtime
variable explicitly:

```env
BRIDGE_OMX_ENV_ALLOWLIST=PATH,HOME,CODEX_HOME,OPENAI_API_KEY,CUSTOM_TOOL_ENV
```

Captured stdout/stderr are bounded by `BRIDGE_MAX_OUTPUT_CHARS` per stream. When
output exceeds the limit, the bridge keeps both the beginning and the end with a
truncation marker in the middle so late build/test failures remain visible.

`BRIDGE_HOST` defaults to `127.0.0.1`. If it is set to a non-loopback host
such as `0.0.0.0`, startup requires both:

```env
BRIDGE_API_TOKEN=<generated>
BRIDGE_CALLBACK_SECRET=<shared-secret>
```

`BRIDGE_ALLOWED_CWD_PREFIXES` restricts per-job `cwd` values. It is a
comma-separated list; `~` expands to the service user's home directory. When
unset, the bridge allows cwd values under the service user's home directory.
Jobs that omit `cwd` keep the existing behavior and run from the service
working directory. Provided `cwd` values must resolve via `realpath` under an
allowed prefix; symlinks that point outside the allowed tree are rejected at
submission time and again immediately before `omx exec` starts.

```env
BRIDGE_ALLOWED_CWD_PREFIXES=~/workspace,/srv/projects
```

### Queue capacity and retention

The bridge rejects new job submissions once active jobs (`queued` + `running`) reach
`BRIDGE_MAX_ACTIVE_JOBS`. Existing jobs are never dropped to make room for new ones.

```env
BRIDGE_MAX_CONCURRENCY=4
BRIDGE_MAX_ACTIVE_JOBS=50
```

Completed job files are cleaned up on service startup and then periodically. Only
terminal jobs (`succeeded`, `failed`, `cancelled`) are eligible for deletion;
`queued` and `running` jobs are always retained.

```env
BRIDGE_JOB_RETENTION_DAYS=7
BRIDGE_MAX_TERMINAL_JOBS=1000
BRIDGE_JOB_CLEANUP_INTERVAL_MS=3600000
```

Job files are stored as JSON under `BRIDGE_JOBS_DIR` and include the submitted
`prompt`, captured `stdout`, captured `stderr`, routing fields, and notification
history in plain text. Treat the directory as sensitive local state. If prompts
or command output may contain tokens, customer data, or private paths, restrict
filesystem access and shorten retention for the deployment:

```env
BRIDGE_JOB_RETENTION_DAYS=1
BRIDGE_MAX_TERMINAL_JOBS=100
```

### API token guard

`BRIDGE_API_TOKEN` protects all non-callback routes (`POST /jobs`, `GET /jobs[/:id]`, `POST /jobs/:id/cancel`) with a Bearer token. When unset, the guard is disabled and these routes accept all requests — appropriate for the default `BRIDGE_HOST=127.0.0.1` localhost-only deployment.

`/callback` is intentionally excluded — it carries its own HMAC signature via `BRIDGE_CALLBACK_SECRET` (different concern: bind-to-body, not just identity).

#### When to enable

- The bridge is exposed beyond loopback (`BRIDGE_HOST=0.0.0.0`).
- Multiple unprivileged users share the host.
- Defense-in-depth even on localhost-only deployments.

#### Deployment procedure (lockstep)

The bridge and every caller must agree on the same token before the guard is enabled. Enabling the guard with a missing client config will return `401 Unauthorized` to that client.

**1. Generate a token.**

```bash
openssl rand -hex 32
```

**2. Set on the bridge.** Edit `~/workspace/omx-bridge/.env`:

```env
BRIDGE_API_TOKEN=<generated>
```

**3. Propagate to every caller.** Same value in every place a caller reads its config from.

- **omx-dispatch (Claude Code MCP server).** Add to the `env` block of the omx-dispatch entry in `~/.claude.json` under `mcpServers.omx-dispatch.env`:

  ```json
  "omx-dispatch": {
    "command": "node",
    "args": ["/path/to/omx-bridge/omx-dispatch/dist/index.js"],
    "env": {
      "BRIDGE_URL": "http://localhost:3992",
      "BRIDGE_CALLBACK_SECRET": "<same as bridge .env>",
      "BRIDGE_API_TOKEN": "<same generated token>",
      "ENABLE_CLAUDE_CHANNEL": "true"
    }
  }
  ```

  Setting it explicitly here is the most reliable path because Claude Code spawns MCP servers with this `env` block and we don't have to depend on parent-env inheritance.

- **omx-bridge-plugin (OpenClaw plugin).** In the OpenClaw plugin config:

  ```json
  {
    "plugins": {
      "entries": {
        "omx-bridge-plugin": {
          "config": {
            "bridgeUrl": "http://localhost:3992",
            "callbackSecret": "<same as bridge .env>",
            "apiToken": "<same generated token>"
          }
        }
      }
    }
  }
  ```

- **claude-synapse (Telegram broker).** Edit `~/workspace/claude-synapse/.env`:

  ```env
  BRIDGE_CALLBACK_SECRET=<same as bridge .env>
  BRIDGE_API_TOKEN=<same generated token>
  ```

  Synapse loads its `.env` programmatically and inherits to spawned Claude workers, so the worker's omx-dispatch picks the value up via env inheritance.

  Setting `BRIDGE_CALLBACK_SECRET` here also enables HMAC verification on synapse's `/notify` endpoint (it currently accepts unsigned bodies when the secret is unset).

- **claude-resident (CLI launcher).** Inherits from the same `omx-bridge/.env` it loads. No separate change needed once step 2 is done.

**4. Restart in lockstep.**

```bash
systemctl --user restart omx-bridge
systemctl --user restart claude-synapse
```

Restart any active Claude Code CLI sessions so they respawn `omx-dispatch` with the new MCP `env` block.

**5. Verify.**

```bash
# Should reject without token (401):
curl -i -X POST http://127.0.0.1:3992/jobs \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"ping"}'

# Should accept with token (202):
curl -i -X POST http://127.0.0.1:3992/jobs \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $BRIDGE_API_TOKEN" \
  -d '{"prompt":"ping"}'
```

#### Disabling the guard

Remove or comment out `BRIDGE_API_TOKEN` from `~/workspace/omx-bridge/.env` and restart `omx-bridge`. Callers that still send the header will be ignored (header is parsed but unused when the guard is disabled).

## Claude Code MCP Server

The MCP server submits jobs and injects its own session-local notify URL:

```text
notifyUrl = http://127.0.0.1:${WEBHOOK_PORT}/notify
```

Available tools:

| Tool | Description |
|------|-------------|
| `omx_submit_job` | Submit a prompt to the bridge and return the job id. Accepts `executionMode`, `originRoutingKey`, `notifyUrl`, `source`, and `sourceName` for backend selection and callback routing. |
| `omx_submit_job_and_wait` | Submit a prompt, then wait for that specific job to complete in the same tool call |
| `omx_get_job` | Fetch status and result for a specific job |
| `omx_get_job_session` | Fetch compact tmux session status and attach command details for a specific job |
| `omx_wait_for_job` | Wait for an existing job to complete without draining other pending notifications |
| `omx_list_jobs` | List jobs, optionally filtered by status |
| `omx_cancel_job` | Cancel a queued or running job |
| `omx_callback_job` | Mark a job as completed via callback (signs request when `BRIDGE_CALLBACK_SECRET` is set) |
| `omx_get_notifications` | Atomically drain all pending completion notifications from the shared webhook notification store |
| `omx_health` | Inspect bridge reachability, job stats, and pending dispatch notifications in one response |
| `omx_notification_stats` | Inspect pending notification count/store metadata without draining |

Important `omx-dispatch/.env` values:

```env
BRIDGE_URL=http://localhost:3992
BRIDGE_CALLBACK_SECRET=shared-secret
BRIDGE_REQUEST_TIMEOUT_MS=10000
# WEBHOOK_PORT=12345  # omit to auto-assign from 12000-12999
ENABLE_CLAUDE_CHANNEL=true  # required for callback-to-CLI continuation; false only queues for polling
MAX_NOTIFICATION_QUEUE_SIZE=200
OMX_DISPATCH_WAIT_TIMEOUT_MS=300000
OMX_DISPATCH_WAIT_POLL_INTERVAL_MS=1000
# Optional JSONL store for pending completion notifications.
# Defaults to .omx/state/omx-dispatch-notifications.jsonl under the MCP process cwd.
# OMX_DISPATCH_NOTIFICATION_STORE_PATH=/path/to/omx-bridge/.omx/state/omx-dispatch-notifications.jsonl
```

`WEBHOOK_PORT` is optional. When omitted, the MCP server picks a free port in the 12000–12999 range at startup, so concurrent Claude Code sessions do not conflict.

Completion notifications are appended to the JSONL store and mirrored in memory for local health/logging. On `omx-dispatch` startup, pending notifications are restored from that file. `omx_get_notifications` uses the persisted store as the source of truth so a different dispatch process can drain completions received by another webhook port.

When multiple `omx-dispatch` processes run from the same working directory, they intentionally share the persisted notification file. `omx_get_notifications` reads that shared JSONL store under a lock, deduplicates notifications by job id, clears the store, and returns each pending completion once. Use `omx_notification_stats` to inspect the shared pending count, store path, store size, and a bounded preview without draining.

Configure a distinct `OMX_DISPATCH_NOTIFICATION_STORE_PATH` only when sessions must be isolated from each other.

For interactive CLI sessions that should continue when a job finishes, prefer `omx_submit_job_and_wait`. It submits the job and long-polls that job until completion, draining only that job's notification from the shared store. Other pending job notifications stay queued for `omx_get_notifications` or their own `omx_wait_for_job` calls. The default wait timeout is 5 minutes and can be overridden per tool call or with `OMX_DISPATCH_WAIT_TIMEOUT_MS`.

## Claude Code Channels Preview

`omx-dispatch` can emit Claude Code channel events for OMX completion notifications when enabled:

```env
ENABLE_CLAUDE_CHANNEL=true
```

This is not enough by itself. Claude Code must also be launched with channel loading enabled. For development preview usage, that may require a Claude Code option such as:

```bash
claude --dangerously-load-development-channels ...
```

Operational requirements:

- Leave `WEBHOOK_PORT` unset (default) so each session auto-binds a unique port in 12000–12999.
- Set `ENABLE_CLAUDE_CHANNEL=true` in the MCP server environment.
- Keep `BRIDGE_CALLBACK_SECRET` consistent between bridge service and MCP server.
- Keep Telegram fallback configured until channel wake-up is verified in both CLI and resident sessions.
- Treat channel payloads as untrusted job output; the MCP server sends only bounded job fields.

Expected channel flow:

```text
Claude Code -> omx_submit_job
omx-bridge -> OMX job complete
omx-bridge -> POST job.notifyUrl
omx-dispatch /notify
omx-dispatch -> notifications/claude/channel
Claude Code -> summarize result / continue workflow
```

If `ENABLE_CLAUDE_CHANNEL=false`, the MCP server still keeps the persisted notification queue and logging path for `omx_get_notifications`.

## Testing

Run all tests:

```bash
npm test
```

Run unit tests only:

```bash
npm run test:unit
```

Run e2e tests only:

```bash
npm run test:e2e
```

Build checks:

```bash
npm run build
cd omx-dispatch && npm run build
```

Run the automated loopback runtime smoke:

```bash
npm run verify:runtime
```

This runs build artifacts with fake OMX shims and verifies bridge API submission, cancellation, per-job webhook notification, `omx-dispatch` MCP submit-and-wait, and optional OpenClaw plugin discovery when the local `openclaw` CLI is installed.

Run the opt-in live OMX smoke only when the local `omx` command and model credentials are configured:

```bash
npm run verify:runtime:live
```

This submits one real `omx exec` job through a temporary loopback bridge and verifies the local callback path without contacting live Telegram or OpenClaw hooks.

This is an operator smoke, not a deterministic CI gate: it uses local provider credentials, can consume model quota, and may fail because of local OMX/model state rather than a bridge regression.

## Notes

- The job queue is file-backed; interrupted `running` jobs are marked `failed` on service startup to avoid duplicate execution.
- The bridge creates `.omx-bridge-instance.lock` in `BRIDGE_JOBS_DIR` on startup and refuses to run a second live instance against the same job directory. Stale lock files are recovered automatically when the recorded process is no longer alive.
- New job submissions are rejected with `429 Too Many Requests` when `queued + running` jobs reach `BRIDGE_MAX_ACTIVE_JOBS`.
- Terminal job files are cleaned up by age and maximum-count retention; active jobs are not deleted by cleanup.
- Job files retain prompts and captured output in plain text until cleanup removes them.
- Webhook payloads use `id` as the canonical job identifier. The MCP webhook accepts legacy `jobId` and normalizes it to `id`.
- The MCP webhook exits on bind failure so port conflicts are visible instead of silently routing notifications to another session.
- `notifyUrl` values submitted through `POST /jobs` must be valid HTTP(S) URLs targeting a loopback host.
- The MCP webhook keeps at most `MAX_NOTIFICATION_QUEUE_SIZE` pending notifications in the shared JSONL store, uses a file lock for cross-process drain, and deduplicates by job id before returning notifications.
- Job ids are validated against UUID format; non-UUID values are rejected to prevent path traversal.
- On timeout or cancellation, a SIGKILL is sent 5 seconds after SIGTERM to ensure child processes are always reaped.
- When `BRIDGE_CALLBACK_SECRET` is set, `POST /jobs/:id/callback` requires an `X-Callback-Signature: sha256=<hex>` header. The MCP server and plugin sign callback requests automatically when the secret is configured.
- `originRoutingKey` is a first-class job field (e.g. `telegram:direct:123456`) that identifies the conversation that initiated the job. Channel brokers such as `claude-chopper` read this field to route callback results back to the correct chat. Legacy callers may instead pass `metadata.synapseRoutingKey`; `originRoutingKey` takes precedence.
- `source` accepts `dispatch`, `channel`, `synapse`, and `openclaw`. New broker-owned chat integrations should use `source: "channel"` plus `sourceName` (for example `claude-chopper`) instead of adding app-specific source enum values.
- `source: "openclaw"` is bridge-owned direct delivery. `originRoutingKey` on an OpenClaw job is correlation context unless a per-job `notifyUrl` owns callback delivery; configured Telegram fallback still targets `TELEGRAM_NOTIFY_CHAT_ID`, not the routing key.
