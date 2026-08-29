# Release Verification Checklist

Use this checklist before merging or deploying bridge changes. It separates deterministic checks from operator-only runtime smoke so CI and release evidence do not depend on local model accounts.

## Verification Lanes

| Lane | Command | Use as CI gate | Requires local ports | Requires model credentials | Covers |
| --- | --- | --- | --- | --- | --- |
| Public hygiene guard | `npm run verify:public-hygiene` | Yes, before public release | No | No | Local operator paths, live-looking hook session keys, tracked local OMX artifacts |
| Deterministic build/test | `npm run verify` | Yes | No | No | Root tests/build, dispatch typecheck/build/tests, plugin typecheck/build/tests |
| Loopback runtime smoke | `npm run verify:runtime` | Yes, as the dependent fake-runtime job | Yes | No | Built bridge runtime, dispatch MCP, local webhook callback, cancel path, fake live-OMX wiring |
| Live OMX operator smoke | `npm run verify:runtime:live` | No | Yes | Yes | One real `omx exec` job through a temporary loopback bridge and local callback webhook |

Do not make `verify:runtime:live` a required CI or merge gate unless the runner has explicit model credentials, quota monitoring, and triage for model output variability.

## CI Gate And Node Support Evidence

The actual CI gate is [`.github/workflows/verify.yml`](../.github/workflows/verify.yml).
Its Node 22 and 24 matrix first runs public hygiene plus deterministic verification,
then starts a dependent fake-runtime job only after every deterministic matrix job
passes. Each job installs the root, dispatch, and plugin lockfiles independently
with `npm ci`; no provider or model credential is required.

The repository's semver-admitted runtime range is Node `>=22.19.0`. The smaller
CI-tested set is Node 22 and 24; other admitted future majors are not CI-verified
by this workflow. Node 18 is not supported by the current dependency graph.
The original Stage 5 candidate set `{18, 24}` was replaced with `{22, 24}` after
the plugin's pinned OpenClaw graph failed its Node 18 clean install and the locked
`undici@8.1.0` established Node `22.19.0` as the effective minimum.

| Node major | selection rationale | root npm ci | dispatch npm ci | plugin npm ci | verify | verify:runtime | matrix decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 22 | Dependency-derived floor, locally verified with Node v22.19.0 / npm 10.9.3 | PASS | PASS | PASS | PASS | PASS | Include |
| 24 | Observed operator line, locally verified with Node v24.14.1 / npm 11.19.0 | PASS | PASS | PASS | PASS | PASS | Include |

This table records disposable local branch evidence, not permanent hosted-CI
evidence for every future release. A workflow definition alone is never proof
that a candidate passed: record the exact candidate SHA and a successful hosted
run URL separately for each release, and require green deterministic and
fake-runtime jobs for that same revision.

## License And Publication Gate

Before publishing a GitHub Release, verify all of the following:

- the tagged tree contains the intended license text
- the root, dispatch, and plugin manifests and lockfile root metadata agree on
  version and license
- the dependency-license audit has no unresolved incompatible or unknown
  runtime dependency
- GitHub automatic source archives are distinguished from separately uploaded
  binary or bundled dependency assets
- all three npm packages remain private and unpublished unless a separate npm
  publication policy is explicitly approved

The immutable `v0.1.0` tag was created as a provenance marker before the
license/publication contract existed and did not receive a GitHub Release. The
corrective `v0.1.1` candidate establishes the MIT source-distribution contract;
its hosted CI, main promotion, tag, and release remain separate evidence gates.

## Pre-Merge Checklist

Run this before public release or release-readiness changes:

```bash
npm run verify:public-hygiene
```

Run this before merging ordinary code changes:

```bash
npm run verify
```

Run the loopback runtime smoke locally when the change touches runtime behavior, bridge configuration, dispatch tooling, plugin wiring, notification/callback code, auth guards, or job lifecycle behavior. CI runs the same command as a required dependent job:

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

- `npm run verify:public-hygiene` has passed for public release or
  release-readiness changes
- required lane commands for the change type pass
- the `Bridge verification` workflow's deterministic and fake-runtime jobs are green
- any generated agent-surface sync has passed the manual harness-sync checklist
- any operator-only live smoke failures are either fixed or explicitly classified as non-bridge local/model failures
- live Telegram/OpenClaw delivery gaps are documented when those integrations were not intentionally exercised
- the working tree is clean except for intended commits
