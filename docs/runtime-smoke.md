# Runtime Smoke Checks

Use this checklist after changing bridge runtime code, dispatch tooling, OpenClaw plugin config, auth settings, or systemd service wiring.

## Process cleanup platform contract

On POSIX, direct `omx exec` children are deliberately owned process-group leaders. Timeout, abort, and
shutdown target the owned group with one bounded TERM-to-KILL escalation. On Windows the bridge uses
`child.kill` for the direct child only; descendant cleanup is not guaranteed by this fallback.

The supported production abnormal-exit boundary is the provided systemd unit:
`KillMode=control-group`, `TimeoutStopSec=30s`, and `SendSIGKILL=yes`. Its
30-second stop window leaves headroom over the default 5-second child escalation
and the runner's bounded in-flight, notification, and cleanup waits. The
deterministic runtime smoke inspects and signals only the uniquely owned fake
process trees it creates. A forced bridge kill outside systemd is diagnostic
evidence only: descendant cleanup after `SIGKILL`, a host crash, or supervisor
failure is not guaranteed without cgroup-aware containment.

For merge/release gate selection, start with [release-verification.md](release-verification.md). This document contains the detailed runtime smoke procedures.

The checks assume the default local bridge URL:

```bash
export BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:3992}"
```

Default strict mode requires the bridge API token and callback secret. Keep both in the shell for authenticated checks:

```bash
export BRIDGE_API_TOKEN="<token from omx-bridge .env>"
export BRIDGE_CALLBACK_SECRET="<callback secret from omx-bridge .env>"
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

The root, dispatch, and plugin test suites also share
`contracts/bridge-job.contract.json` as the representative bridge job/session
contract. If job payload fields, session summary fields, status values,
execution error types, or routing fields change, update that fixture and keep
these companion tests in the same change:

- `test/unit/bridge-contract.spec.ts`
- `omx-dispatch/contract-fixtures.test.ts`
- `omx-bridge-plugin/test/index.test.ts`

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
- owned direct-exec descendant cleanup for cancel, timeout, and graceful shutdown,
  plus a separately reported non-systemd forced-termination diagnostic
- `omx-dispatch` MCP `omx_health` and `omx_submit_job_and_wait`
- live OMX smoke wiring with a fake OMX command
- optional OpenClaw plugin discovery when the `openclaw` CLI is installed

The automated smoke does not run the real OMX CLI and does not contact live Telegram or OpenClaw hooks. Keep the manual checks below for deployed service wiring, real OMX execution, and external notification delivery.

Tmux collection reads only bounded head/tail regions and retained terminal/session
artifacts follow the configured job retention policy. Running tmux `stdout.log`
and `stderr.log` artifacts are additionally capped independently by
`BRIDGE_TMUX_MAX_CAPTURE_BYTES_PER_STREAM` (default: `1048576` bytes). The cap
keeps the head in the log and the latest tail in private session-local ring
artifacts. The two artifacts together remain within the per-stream cap, and the
sidecar is removed after finalization; terminal collection reassembles head,
marker, and tail while discarding the middle without failing a verbose job. It is separate from
`BRIDGE_MAX_OUTPUT_CHARS`, which limits the terminal/API character response.

Run the opt-in live OMX execution smoke only when local model credentials and `omx` are configured:

```bash
npm run verify:runtime:live
```

This starts a temporary loopback bridge and submits one job through the real `omx exec` command. It still uses a local callback webhook and does not contact live Telegram or OpenClaw hooks.

Treat this as an operator smoke, not a deterministic CI/release gate. It uses local provider credentials, may consume model quota, and can fail because of local `omx` installation, account state, model routing, or model output variability rather than a bridge regression.

Optional knobs:

```bash
OMX_LIVE_SMOKE_COMMAND=/path/to/omx npm run verify:runtime:live
OMX_LIVE_SMOKE_TIMEOUT_MS=600000 npm run verify:runtime:live
KEEP_RUNTIME_SMOKE_DIR=1 npm run verify:runtime
RUNTIME_SMOKE_DIAGNOSTICS_VERBOSE=1 npm run verify:runtime
```

`KEEP_RUNTIME_SMOKE_DIR=1` works for both loopback and live runtime smoke. On
failure, the smoke script prints bridge output/job JSON summaries/notification
JSONL summaries with sensitive fields redacted, plus the temporary directory
path. A failed real live-OMX job also includes a bounded 1,200-character
head/tail preview of its redacted stderr before the default temp cleanup. Exact
provider credentials, bridge secrets, prompt-shaped secrets, and HOME/CODEX_HOME
paths are removed from that preview. In the same live-safe diagnostics, the job
state path is reported as `<job-state>` instead of a correlation-bearing
filename, and the final bounded failure stack is redacted before printing. Raw
job JSON and raw stack text are not printed. Stdout and broader failure previews
remain opt-in through `RUNTIME_SMOKE_DIAGNOSTICS_VERBOSE=1` for local triage.

Expected:

- job status is `succeeded`
- job output includes `OMX_BRIDGE_LIVE_SMOKE_OK`
- completion reaches the local callback webhook

If the live smoke fails, first separate bridge failures from local OMX/model failures:

- Bridge likely failed if `/jobs` submission, job polling, cwd validation, or local callback delivery fails.
- Local OMX/model likely failed if the job reaches `failed`, times out, lacks provider credentials, exhausts quota, or omits the expected marker.

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
curl -sS "$BRIDGE_URL/jobs/stats" \
  ${BRIDGE_API_TOKEN:+-H "Authorization: Bearer $BRIDGE_API_TOKEN"}
```

Unauthenticated mutation should fail:

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
          "apiToken": "<BRIDGE_API_TOKEN>",
          "callbackSecret": "<BRIDGE_CALLBACK_SECRET>"
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
omx_get_job_session
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
- `channel`: broker owns final chat routing using `originRoutingKey`; legacy `source: "synapse"` submissions normalize here with `sourceName: "claude-synapse"`
- `openclaw`: bridge/OpenClaw integration owns final delivery

Do not validate channel routing by adding direct Telegram fallback in the bridge. The broker should receive the completion payload and route it.

## 8. Failure Triage

If a job is terminal but the caller did not wake up:

1. Inspect the job:

```bash
curl -sS "$BRIDGE_URL/jobs/<job id>" \
  ${BRIDGE_API_TOKEN:+-H "Authorization: Bearer $BRIDGE_API_TOKEN"}
```

2. Check `notifyOutcome` and `notifyHistory`.
   - If `notifyOutcome` is absent, startup reconciliation treats the notification
     as never attempted and runs one reconciliation delivery operation. That
     operation still uses the configured per-delivery retry delays.
   - If `notifyOutcome` records a failed or skipped delivery, a service restart
     does not retry it automatically. This prevents restart-driven webhook storms;
     use the authenticated manual retry endpoint when another attempt is intended.
3. Retry a recorded failure only when delivery should be attempted again:

```bash
curl -sS -X POST "$BRIDGE_URL/jobs/<job id>/notify/retry" \
  ${BRIDGE_API_TOKEN:+-H "Authorization: Bearer $BRIDGE_API_TOKEN"}
```

The job must be terminal. The retry result is appended to the bounded
`notifyHistory`, which retains the latest 10 attempts.

4. In dispatch, run `omx_notification_stats`.
5. If a notification is pending and should be consumed, run `omx_wait_for_job`
   for the specific job or `omx_get_notifications` for all pending notifications.
6. Check bridge logs with `journalctl --user -u omx-bridge -n 120 --no-pager`.

## 9. Completion Criteria

A runtime smoke pass is complete when:

- build artifacts succeed
- bridge service is active
- `GET /jobs/stats` works
- authenticated submit/get/cancel paths work
- `omx_health` reports bridge reachable
- dispatch submit-and-wait completes
- OpenClaw plugin config points at `http://localhost:3992`
- no unexpected duplicate bridge process is running against the same job directory
