# Runtime Smoke Checks

Use this checklist after changing bridge runtime code, dispatch tooling, OpenClaw plugin config, auth settings, or systemd service wiring.

The checks assume the default local bridge URL:

```bash
export BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:3992}"
```

If `BRIDGE_API_TOKEN` is configured, keep it in the shell for authenticated checks:

```bash
export BRIDGE_API_TOKEN="<token from omx-bridge .env>"
```

## 1. Automated Verification

Run the aggregate verification script before runtime smoke checks:

```bash
npm run verify
```

This covers:

- root bridge tests and build
- `omx-dispatch` typecheck, build, and tests
- `omx-bridge-plugin` typecheck, build, and tests

Run the automated runtime smoke after build/test verification:

```bash
npm run verify:runtime
```

`npm run smoke:runtime` is the same loopback runtime smoke command. It is kept separate from the aggregate `npm run verify` so CI or local runs can opt into port-binding runtime checks explicitly.

This starts temporary loopback bridge instances from build artifacts with isolated job directories and fake OMX shims. It verifies:

- authenticated bridge API submit/get flow
- per-job `notifyUrl` delivery to a local webhook
- OpenClaw `source`, `sourceName`, `originRoutingKey`, and `metadata` preservation
- cancellation terminal state and notification persistence
- `omx-dispatch` MCP `omx_health` and `omx_submit_job_and_wait`
- optional OpenClaw plugin discovery when the `openclaw` CLI is installed

The automated smoke does not run the real OMX CLI and does not contact live Telegram or OpenClaw hooks. Keep the manual checks below for deployed service wiring, real OMX execution, and external notification delivery.

## 2. Build Artifacts

Run all build surfaces that may be launched at runtime:

```bash
npm run build
cd omx-dispatch && npm run build
cd ../omx-bridge-plugin && npm run build
```

## 3. Bridge Service

For the user service:

```bash
systemctl --user status omx-bridge
journalctl --user -u omx-bridge -n 80 --no-pager
```

Expected:

- service is active
- no startup crash
- no repeated restart loop
- no stale lock error for a live process

The bridge should create one lock file under `BRIDGE_JOBS_DIR`:

```bash
find .omx/state/bridge-jobs -maxdepth 1 -name '.omx-bridge-instance.lock' -print -exec cat {} \;
```

If a second bridge instance points at the same `BRIDGE_JOBS_DIR`, it should fail fast instead of competing for jobs.

## 4. Bridge API

Stats should be reachable:

```bash
curl -sS "$BRIDGE_URL/jobs/stats"
```

When `BRIDGE_API_TOKEN` is set, unauthenticated mutation should fail:

```bash
curl -i -X POST "$BRIDGE_URL/jobs" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"smoke unauthenticated"}'
```

Expected: `401 Unauthorized`.

Submit an authenticated smoke job:

```bash
JOB_RESPONSE="$(curl -sS -X POST "$BRIDGE_URL/jobs" \
  -H 'Content-Type: application/json' \
  ${BRIDGE_API_TOKEN:+-H "Authorization: Bearer $BRIDGE_API_TOKEN"} \
  -d '{"prompt":"Reply OK only.","requestId":"smoke-bridge-api","source":"openclaw"}')"

printf '%s\n' "$JOB_RESPONSE"
```

Extract the job id with your preferred JSON tool, then inspect it:

```bash
JOB_ID="<job id from response>"

curl -sS "$BRIDGE_URL/jobs/$JOB_ID" \
  ${BRIDGE_API_TOKEN:+-H "Authorization: Bearer $BRIDGE_API_TOKEN"}
```

Expected:

- initial `status` is `queued` or `running`
- terminal state becomes `succeeded` or `failed`
- `requestId` and `source` are preserved

Cancel path smoke:

```bash
CANCEL_RESPONSE="$(curl -sS -X POST "$BRIDGE_URL/jobs" \
  -H 'Content-Type: application/json' \
  ${BRIDGE_API_TOKEN:+-H "Authorization: Bearer $BRIDGE_API_TOKEN"} \
  -d '{"prompt":"sleep long enough to cancel","requestId":"smoke-cancel","source":"openclaw"}')"

printf '%s\n' "$CANCEL_RESPONSE"
CANCEL_JOB_ID="<job id from response>"

curl -sS -X POST "$BRIDGE_URL/jobs/$CANCEL_JOB_ID/cancel" \
  ${BRIDGE_API_TOKEN:+-H "Authorization: Bearer $BRIDGE_API_TOKEN"}
```

Expected: terminal `status` is `cancelled`, and `notifyOutcome` appears after notification persistence.

## 5. Dispatch MCP

From a Claude Code session with `omx-dispatch` loaded, run:

```text
omx_health
```

Expected:

- `bridge.reachable: true`
- `bridge.stats` contains `queuedCount`, `runningCount`, `activeCount`, and limits
- `notifications.pending` is present
- `notifications.storePath` points at the expected JSONL store

Submit and wait:

```text
omx_submit_job_and_wait({
  "prompt": "Reply OK only.",
  "requestId": "smoke-dispatch-wait",
  "source": "dispatch"
})
```

Expected:

- result contains a `jobId`
- `completed: true`
- terminal `status` is `succeeded` or `failed`
- if notification delivery is missing, `notificationMissing` explains that the bridge terminal state was observed without a queued notification

Check pending notifications without draining:

```text
omx_notification_stats({ "previewCount": 5 })
```

Drain only when you intentionally want to consume queued notifications:

```text
omx_get_notifications({})
```

## 6. OpenClaw Plugin

Confirm plugin config uses the bridge's runtime port:

```json
{
  "plugins": {
    "entries": {
      "omx-bridge-plugin": {
        "enabled": true,
        "config": {
          "bridgeUrl": "http://localhost:3992",
          "apiToken": "<BRIDGE_API_TOKEN when configured>",
          "callbackSecret": "<BRIDGE_CALLBACK_SECRET when configured>"
        }
      }
    }
  }
}
```

Confirm plugin discovery:

```bash
openclaw plugins list
openclaw plugins info omx-bridge-plugin
```

Confirm tool allowlists include either `omx-bridge-plugin` or the concrete tools:

```text
omx_submit_job
omx_get_job
omx_list_jobs
omx_cancel_job
```

Submit a small OpenClaw-side job and verify:

- job `source` is `openclaw`
- bridge receives the job
- completion notification reaches the configured OpenClaw hook or Telegram path when enabled

## 7. Routing Sanity

Before testing broker-owned routing, re-check the contract:

```text
docs/routing-contract.md
```

Expected source behavior:

- `dispatch`: completion goes to dispatch session-local `notifyUrl`
- `channel`: broker owns final chat routing using `originRoutingKey`
- `openclaw`: bridge/OpenClaw integration owns final delivery
- `synapse`: legacy broker-owned routing

Do not validate channel routing by adding direct Telegram fallback in the bridge. The broker should receive the completion payload and route it.

## 8. Failure Triage

If a job is terminal but the caller did not wake up:

1. Inspect the job:

```bash
curl -sS "$BRIDGE_URL/jobs/<job id>" \
  ${BRIDGE_API_TOKEN:+-H "Authorization: Bearer $BRIDGE_API_TOKEN"}
```

2. Check `notifyOutcome` and `notifyHistory`.
3. In dispatch, run `omx_notification_stats`.
4. If a notification is pending and should be consumed, run `omx_wait_for_job` for the specific job or `omx_get_notifications` for all pending notifications.
5. Check bridge logs with `journalctl --user -u omx-bridge -n 120 --no-pager`.

## 9. Completion Criteria

A runtime smoke pass is complete when:

- build artifacts succeed
- bridge service is active
- `GET /jobs/stats` works
- authenticated submit/get/cancel paths work when auth is enabled
- `omx_health` reports bridge reachable
- dispatch submit-and-wait completes
- OpenClaw plugin config points at `http://localhost:3992`
- no unexpected duplicate bridge process is running against the same job directory
