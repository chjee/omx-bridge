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
- `.omx/state/bridge-jobs`: default job state directory.

## Setup

Install dependencies:

```bash
npm install
cd omx-bridge-mcp && npm install
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

Build both packages:

```bash
npm run build
cd omx-bridge-mcp && npm run build
```

## Bridge Service Configuration

Important root `.env` values:

```env
PORT=3992
BRIDGE_JOBS_DIR=.omx/state/bridge-jobs
OMX_COMMAND=omx
NOTIFY_MODE=openclaw
```

Notification modes:

- `openclaw`: send OpenClaw hook notifications and direct Telegram notifications when configured.
- `claude`: POST job completion to `CLAUDE_NOTIFY_URL`; Telegram settings provide fallback push.

In claude notify mode, Telegram fallback behaviour depends on whether a per-job `notifyUrl` was supplied:

- **`notifyUrl` absent**: Telegram is used as a fallback when the configured `CLAUDE_NOTIFY_URL` webhook cannot be delivered.
- **`notifyUrl` present**: Telegram fallback is skipped — the per-job URL takes full ownership of the callback. This keeps per-chat routing consistent when used with synapse or similar brokers.

For Claude mode:

```env
NOTIFY_MODE=claude
CLAUDE_NOTIFY_URL=http://127.0.0.1:<port>/notify  # omx-dispatch auto-assigns port in 12000-12999
BRIDGE_CALLBACK_SECRET=shared-secret
TELEGRAM_BOT_TOKEN=optional-fallback-token
TELEGRAM_NOTIFY_CHAT_ID=optional-fallback-chat-id
```

`BRIDGE_CALLBACK_SECRET` must match the MCP server env when webhook signature verification is enabled.

## Claude Code MCP Server

The MCP server submits jobs and injects its own session-local notify URL:

```text
notifyUrl = http://127.0.0.1:${WEBHOOK_PORT}/notify
```

Available tools:

| Tool | Description |
|------|-------------|
| `omx_submit_job` | Submit a prompt to the bridge and return the job id. Accepts `originRoutingKey` and `notifyUrl` for callback routing. |
| `omx_get_job` | Fetch status and result for a specific job |
| `omx_list_jobs` | List jobs, optionally filtered by status |
| `omx_cancel_job` | Cancel a queued or running job |
| `omx_callback_job` | Mark a job as completed via callback (signs request when `BRIDGE_CALLBACK_SECRET` is set) |
| `omx_get_notifications` | Drain all pending completion notifications from the local webhook queue |

Important `omx-dispatch/.env` values:

```env
BRIDGE_URL=http://localhost:3992
BRIDGE_CALLBACK_SECRET=shared-secret
# WEBHOOK_PORT=12345  # omit to auto-assign from 12000-12999
ENABLE_CLAUDE_CHANNEL=false
MAX_NOTIFICATION_QUEUE_SIZE=200
```

`WEBHOOK_PORT` is optional. When omitted, the MCP server picks a free port in the 12000–12999 range at startup, so concurrent Claude Code sessions do not conflict.

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

If `ENABLE_CLAUDE_CHANNEL=false`, the MCP server still keeps the notification queue and logging path for `omx_get_notifications`.

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
cd omx-bridge-mcp && npm run build
```

## Notes

- The job queue is file-backed; interrupted `running` jobs are recovered to `queued` on service startup.
- Webhook payloads use `id` as the canonical job identifier. The MCP webhook accepts legacy `jobId` and normalizes it to `id`.
- The MCP webhook exits on bind failure so port conflicts are visible instead of silently routing notifications to another session.
- `notifyUrl` values submitted through `POST /jobs` must be valid HTTP(S) URLs targeting a loopback host.
- The MCP webhook keeps at most `MAX_NOTIFICATION_QUEUE_SIZE` pending notifications in memory.
- Job ids are validated against UUID format; non-UUID values are rejected to prevent path traversal.
- On timeout or cancellation, a SIGKILL is sent 5 seconds after SIGTERM to ensure child processes are always reaped.
- When `BRIDGE_CALLBACK_SECRET` is set, `POST /jobs/:id/callback` requires an `X-Callback-Signature: sha256=<hex>` header. The MCP server and plugin sign callback requests automatically when the secret is configured.
- `originRoutingKey` is a first-class job field (e.g. `telegram:direct:123456`) that identifies the conversation that initiated the job. Brokers such as `claude-synapse` read this field to route callback results back to the correct chat. Legacy callers may instead pass `metadata.synapseRoutingKey`; synapse accepts both with `originRoutingKey` taking precedence.
