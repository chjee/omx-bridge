# Routing Contract

This document defines how `omx-bridge` routes job completion results back to callers. It is the ownership contract for `source`, `notifyUrl`, `originRoutingKey`, and routing metadata.

## Core Rule

The bridge executes jobs and reports terminal state. It does not own chat-specific routing unless the selected notification mode explicitly says so.

For broker-owned channels, the broker owns final delivery. The bridge preserves routing fields and posts completion payloads to the caller's webhook.

## Job Fields

### `source`

Allowed values:

- `dispatch`: Claude Code CLI / MCP dispatch session.
- `channel`: broker-owned channel routing, for example `claude-chopper`.
- `synapse`: legacy broker routing.
- `openclaw`: direct OpenClaw integration.

`source` is also part of request idempotency. A repeated `requestId` returns an existing job only when the `source` also matches.

### `notifyUrl`

`notifyUrl` is the per-job completion webhook.

- It has priority over `CLAUDE_NOTIFY_URL`.
- It must target a loopback HTTP(S) host.
- If present, it owns callback delivery for that job.
- In `NOTIFY_MODE=claude`, Telegram fallback is skipped when `notifyUrl` is present.

This prevents the bridge from bypassing a channel broker and accidentally double-delivering or misrouting results.

### `originRoutingKey`

`originRoutingKey` identifies the conversation or channel that initiated the job.

Example:

```text
telegram:direct:123456
telegram:group:-1001234567890
```

The bridge stores this field and includes it in completion payloads. It does not parse the key for direct delivery. Channel brokers use it to route the callback result back to the correct chat.

For `source: "openclaw"`, `originRoutingKey` is correlation context only. It does
not make the job broker-owned and does not suppress Telegram fallback when no
per-job `notifyUrl` was supplied.

### `sourceName`

`sourceName` names the concrete broker or integration when `source` is broader than one implementation.

Examples:

```text
claude-chopper
claude-synapse
```

New broker-owned integrations should use:

```json
{
  "source": "channel",
  "sourceName": "my-broker"
}
```

Do not add a new `source` enum value for every broker unless the bridge itself must apply different semantics.

### `metadata`

`metadata` is caller-owned supplemental context. The bridge persists and returns it but should not depend on opaque metadata for core routing when a first-class field exists.

Use first-class fields when possible:

- Use `originRoutingKey` for the initiating conversation.
- Use `sourceName` for the concrete broker.
- Use `notifyUrl` for callback ownership.
- Use `requestId` for idempotency.

Avoid placing secrets in `metadata`; job files are persisted on disk.

## Source Responsibilities

| Source | Final routing owner | Expected routing fields | Bridge behavior |
| --- | --- | --- | --- |
| `dispatch` | Dispatch MCP process | `notifyUrl`, optional `requestId` | Sends completion to dispatch webhook. Dispatch queues notifications for polling/channel events. |
| `channel` | Channel broker | `notifyUrl`, `originRoutingKey`, `sourceName` | Preserves routing fields and posts completion to broker webhook. Skips Telegram fallback. |
| `synapse` | Legacy broker | `notifyUrl` or `CLAUDE_NOTIFY_URL`, legacy metadata as needed | Preserves compatibility fields. Treat as broker-owned routing. |
| `openclaw` | Bridge/OpenClaw integration | OpenClaw hook config, optional Telegram config; optional `originRoutingKey` for correlation | In `NOTIFY_MODE=openclaw`, sends OpenClaw hook and Telegram notification when configured. In `NOTIFY_MODE=claude`, `originRoutingKey` alone does not make the job broker-owned. |

## Notification Modes

### `NOTIFY_MODE=openclaw`

The bridge sends completion notifications directly through configured OpenClaw hooks and Telegram settings.

Use this when OpenClaw is the direct caller and no Claude Code webhook owns the callback path.

### `NOTIFY_MODE=claude`

The bridge sends completion notifications to:

1. Per-job `notifyUrl`, when present.
2. `CLAUDE_NOTIFY_URL`, when no per-job `notifyUrl` is present.

Telegram fallback applies only when no per-job `notifyUrl` was supplied and the configured Claude webhook delivery fails.

## Fallback Policy

Do:

- Let per-job `notifyUrl` own callback delivery.
- Let `channel` brokers own chat routing.
- Treat `source: "openclaw"` as bridge-owned direct delivery unless a per-job
  `notifyUrl` explicitly owns the callback path.
- Use `omx_get_notifications`, `omx_wait_for_job`, or `omx_health` to recover dispatch-side pending completions.
- Add explicit opt-in settings before introducing any direct fallback that bypasses a broker.

Do not:

- Parse `originRoutingKey` inside the bridge to send Telegram messages directly.
- Add Telegram fallback for `source: "channel"`.
- Treat `metadata` as an authority for routing when first-class fields are available.
- Add app-specific `source` enum values for broker variants.

## Dispatch Notes

`omx-dispatch` normally supplies its own session-local `notifyUrl`:

```text
http://127.0.0.1:<port>/notify
```

When the bridge receives a 2xx response from that webhook, delivery is complete from the bridge's perspective. If Claude channel events are disabled, the completion may only be available through `omx_get_notifications` or `omx_wait_for_job`.

`dispatch` may include `originRoutingKey`, but the bridge does not use it for direct delivery. It is returned in the job payload for callers that need to correlate work with an upstream conversation.

## Adding A New Broker

For a new broker-owned chat integration:

1. Use `source: "channel"`.
2. Set `sourceName` to the broker name.
3. Set `originRoutingKey` to the caller conversation key.
4. Provide a loopback `notifyUrl` owned by the broker.
5. Have the broker route completion payloads to the final chat destination.

Only add a new `source` value if the bridge must change behavior for that caller class.
