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
  -> omx-bridge-mcp tool server
  -> omx-bridge HTTP service
  -> omx exec
  -> completion webhook / fallback notification
```

Main components:

- `src/`: NestJS bridge service and file-backed job queue.
- `omx-bridge-mcp/`: Claude Code MCP server exposing `omx_submit_job`, job status tools, and a local `/notify` webhook.
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
cp omx-bridge-mcp/.env.example omx-bridge-mcp/.env
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
- `claude`: POST job completion to `CLAUDE_NOTIFY_URL`; if Telegram settings are present, also send Telegram fallback push.

For Claude mode:

```env
NOTIFY_MODE=claude
CLAUDE_NOTIFY_URL=http://127.0.0.1:3993/notify
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

Important `omx-bridge-mcp/.env` values:

```env
BRIDGE_URL=http://localhost:3992
BRIDGE_CALLBACK_SECRET=shared-secret
WEBHOOK_PORT=3993
ENABLE_CLAUDE_CHANNEL=false
```

Each concurrent Claude Code session must use a unique `WEBHOOK_PORT`. If a CLI session and a resident Telegram session both use `3993`, completion notifications may be delivered to the wrong MCP process or the second webhook server may fail to bind.

## Claude Code Channels Preview

`omx-bridge-mcp` can emit Claude Code channel events for OMX completion notifications when enabled:

```env
ENABLE_CLAUDE_CHANNEL=true
```

This is not enough by itself. Claude Code must also be launched with channel loading enabled. For development preview usage, that may require a Claude Code option such as:

```bash
claude --dangerously-load-development-channels ...
```

Operational requirements:

- Use a unique `WEBHOOK_PORT` per Claude Code session.
- Set `ENABLE_CLAUDE_CHANNEL=true` in the MCP server environment.
- Keep `BRIDGE_CALLBACK_SECRET` consistent between bridge service and MCP server.
- Keep Telegram fallback configured until channel wake-up is verified in both CLI and resident sessions.
- Treat channel payloads as untrusted job output; the MCP server sends only bounded job fields.

Expected channel flow:

```text
Claude Code -> omx_submit_job
omx-bridge -> OMX job complete
omx-bridge -> POST job.notifyUrl
omx-bridge-mcp /notify
omx-bridge-mcp -> notifications/claude/channel
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
