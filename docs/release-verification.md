# Release Verification Checklist

Use this checklist before merging or deploying bridge changes. It separates deterministic checks from operator-only runtime smoke so CI and release evidence do not depend on local model accounts.

## Verification Lanes

| Lane | Command | Use as CI gate | Requires local ports | Requires model credentials | Covers |
| --- | --- | --- | --- | --- | --- |
| Public hygiene guard | `npm run verify:public-hygiene` | Yes, before public release | No | No | Local operator paths, live-looking hook session keys, tracked local OMX artifacts |
| Deterministic build/test | `npm run verify` | Yes | No | No | Root tests/build, dispatch typecheck/build/tests, plugin typecheck/build/tests |
| Loopback runtime smoke | `npm run verify:runtime` | Optional, when runner can bind loopback ports | Yes | No | Built bridge runtime, dispatch MCP, local webhook callback, cancel path, fake live-OMX wiring |
| Live OMX operator smoke | `npm run verify:runtime:live` | No | Yes | Yes | One real `omx exec` job through a temporary loopback bridge and local callback webhook |

Do not make `verify:runtime:live` a required CI or merge gate unless the runner has explicit model credentials, quota monitoring, and triage for model output variability.

## Pre-Merge Checklist

Run this before public release or release-readiness changes:

```bash
npm run verify:public-hygiene
```

Run this before merging ordinary code changes:

```bash
npm run verify
```

Run the loopback runtime smoke when the change touches runtime behavior, bridge configuration, dispatch tooling, plugin wiring, notification/callback code, auth guards, or job lifecycle behavior:

```bash
npm run verify:runtime
```

Expected evidence:

- all unit/e2e/typecheck/build checks pass
- loopback runtime smoke reaches `runtime smoke passed`
- fake live OMX wiring reaches `fake live OMX exec smoke passed`
- no leftover working-tree files are produced by the checks

## Manual Harness-Sync Evidence

Use [agent-workflow.md](agent-workflow.md#harness-sync-gates) as the canonical
gate before applying generated `agent-harness` output or any generated agent
surface to `omx-bridge`.

For release evidence, record:

- the dry-run command and review result
- the `AGENTS.md` manual-marker and Korean-local-notes preservation check
- the missing-target and harness-only-reference check
- the selected bridge verification lane and result
- any unresolved risks still marked `PENDING`

Do not mark a generated agent-surface sync release-ready unless the canonical
harness-sync gate has passed.

## Operator Smoke

Run the live OMX smoke after deployment-sensitive changes, before a manual release, or when validating a workstation/service account:

```bash
npm run verify:runtime:live
```

This command is intentionally outside the deterministic gate. It can fail because of local `omx` installation, provider credentials, model quota, model routing, or LLM output variability even when the bridge code is correct.

Optional knobs:

```bash
OMX_LIVE_SMOKE_COMMAND=/path/to/omx npm run verify:runtime:live
OMX_LIVE_SMOKE_TIMEOUT_MS=600000 npm run verify:runtime:live
KEEP_RUNTIME_SMOKE_DIR=1 npm run verify:runtime:live
RUNTIME_SMOKE_DIAGNOSTICS_VERBOSE=1 npm run verify:runtime:live
```

Use `KEEP_RUNTIME_SMOKE_DIR=1` when diagnosing failures. Runtime smoke prints redacted bridge output/job JSON summaries/notification JSONL summaries and preserves the temporary directory for local inspection. Set `RUNTIME_SMOKE_DIAGNOSTICS_VERBOSE=1` only for local triage when redacted stdout/stderr previews are needed.

Expected evidence:

- live smoke reaches `live OMX exec smoke passed`
- no live Telegram or OpenClaw hooks are contacted
- failures are triaged as bridge, local OMX, credential/quota, or model-output issues

## Deployment Smoke

Use [runtime-smoke.md](runtime-smoke.md) for deployed service checks after systemd, OpenClaw, Telegram fallback, or external callback routing changes.

Deployment smoke should capture:

- service status and recent journal output
- bridge API stats
- authenticated job submit/get/cancel behavior
- dispatch MCP health and submit-and-wait behavior
- OpenClaw plugin discovery and allowlist state
- live external notification delivery only when the relevant credentials and destination are intentionally enabled

## Stop Conditions

A change is release-ready when:

- required lane commands for the change type pass
- any generated agent-surface sync has passed the manual harness-sync checklist
- any operator-only live smoke failures are either fixed or explicitly classified as non-bridge local/model failures
- live Telegram/OpenClaw delivery gaps are documented when those integrations were not intentionally exercised
- the working tree is clean except for intended commits
