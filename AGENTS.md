<!-- OMX:AGENTS-INIT:MANAGED -->
<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT. THIS IS COMPLEMENTARY TO OMX TEAM MODE.
<!-- END AUTONOMY DIRECTIVE -->

# omx-bridge Agent Contract

This file is the short execution contract for `omx-bridge`. Keep detailed
maintenance procedures in `docs/agent-workflow.md` and release verification in
`docs/release-verification.md`.

## Operating Principles

- Solve clear tasks directly and verify before claiming completion.
- Ask only for destructive, irreversible, credentialed, or materially branching
  actions.
- Surface ambiguity, inconsistencies, and trade-offs before choosing a path when
  they affect the correct solution.
- Prefer existing project patterns, scripts, and utilities over new
  abstractions.
- Push back when a simpler or safer approach better fits the requested outcome.
- Keep diffs small, reviewable, reversible, and scoped to the requested lane.
- Do not rewrite unrelated code, comments, or formatting that the task does not
  require.
- Do not add runtime dependencies without explicit approval.
- Do not revert user changes unless explicitly asked.
- Do not edit `.omx/` runtime state, logs, or historical plans unless the task
  explicitly asks for OMX state maintenance.
- Treat installed role prompts and skills as narrower execution surfaces under
  this file.

## Workflows

- Non-trivial brownfield work follows:
  `analyze -> plan/ralplan -> branch implementation -> fresh diff review -> commit/merge/push`.
- Start non-trivial work from a clean `develop` branch unless the user specifies
  another base.
- Keep behavior fixes, documentation cleanup, runtime smoke work,
  dispatch/plugin contract changes, and harness changes in separate branches.
- Work on `agent-harness` only when the user explicitly asks for that repository.
- For cleanup/refactor/deslop work, write a short cleanup plan before edits and
  protect behavior with tests when behavior is not already covered.

## Skill Routing

When the user explicitly invokes a workflow such as `$analyze`, `$ralplan`,
`$code-review`, `$security-review`, `$team`, `$ralph`, or `$cancel`, use the
installed skill for that turn.

Runtime-heavy OMX workflows such as `$team`, `$ralph`, `$autopilot`,
`$ultrawork`, and `$ultraqa` require an actual OMX runtime context. In plain
Codex sessions, use the nearest safe surface: planning, direct execution, or
native subagents.

For simple read-only file, symbol, pattern, and relationship lookups, prefer
`omx explore` when available; otherwise use focused shell inspection with `rg`
first.

## Delegation

- Default posture is solo execution.
- Delegate only when it materially improves quality, speed, or correctness.
- Use native subagents for bounded independent work that can run in parallel.
- Keep delegated tasks concrete, verifiable, and scoped to disjoint ownership.
- Do not use `worker` outside active OMX team/swarm runtime sessions.
- The leader owns integration, final verification, and user-facing status.

## Git And Commits

- Check `git status --short --branch` before broad edits, commits, merges, or
  release-gate work.
- Do not mix unrelated changes in one branch or commit.
- Commit messages must follow the Lore protocol: explain why the change exists,
  then record decision evidence with git-native trailers.
- Include the relevant Lore trailers for every commit:
  `Constraint:`, `Rejected:`, `Confidence:`, `Scope-risk:`, `Directive:`,
  `Tested:`, `Not-tested:`, and `Related:`.
- Include `Co-authored-by: OmX <omx@oh-my-codex.dev>` when repository hooks or
  workflow expectations require OmX attribution.

## Verification

- Identify the smallest declarative, testable evidence that proves the claim,
  run it, read it, and report the result.
- If verification fails, fix and rerun instead of reporting partial success.
- Documentation-only changes: run `git diff --check`.
- Standard code changes: run `npm run verify`.
- Runtime/API/dispatch/plugin/callback/tmux/job lifecycle changes: run
  `npm run verify:runtime` after the relevant build/test gate.
- Live OMX validation uses `npm run verify:runtime:live` only when credentials,
  quota, and local OMX installation are intentionally being exercised.
- Before finishing, confirm the working tree state and any known unverified
  risks.

## Bridge Boundaries

- Preserve bridge runtime behavior unless the task explicitly asks for behavior
  change.
- Treat tmux/session execution, callbacks, job state files, dispatch MCP tools,
  OpenClaw plugin behavior, and shared contract fixtures as integration
  boundaries.
- Keep `contracts/bridge-job.contract.json` aligned with job payload, session
  summary, status, execution error, and routing field changes.
- Runtime behavior and live OMX behavior changes need unit coverage and runtime
  smoke evidence.

## Harness Sync Gates

Treat this file as target-local guidance unless a separate migration plan proves
otherwise. Before applying generated `agent-harness` output:

- review the generated output with `--dry-run`
- inspect the existing `AGENTS.md`
- preserve `<!-- OMX:AGENTS-INIT:MANUAL:START -->` and
  `<!-- OMX:AGENTS-INIT:MANUAL:END -->`
- preserve the Korean local notes inside the manual block
- reject generated output that points to harness-only docs, prompt seeds,
  helper files, or target-local paths missing from `omx-bridge`
- identify the relevant bridge verification lane before accepting the change

Stop instead of syncing when dry-run output has not been reviewed, manual-note
preservation is uncertain, generated output references missing files, or the
required target verification is unknown.

## Runtime Markers

Keep OMX runtime marker contracts stable and non-destructive:

- `<!-- OMX:RUNTIME:START --> ... <!-- OMX:RUNTIME:END -->`
- `<!-- OMX:TEAM:WORKER:START --> ... <!-- OMX:TEAM:WORKER:END -->`
- `<!-- OMX:AGENTS-INIT:MANUAL:START --> ... <!-- OMX:AGENTS-INIT:MANUAL:END -->`

## Documentation Map

- Maintenance workflow: `docs/agent-workflow.md`
- Release verification: `docs/release-verification.md`
- Runtime smoke: `docs/runtime-smoke.md`
- Routing contract: `docs/routing-contract.md`
- Shared job contract source of truth: `docs/contract-source-of-truth.md`

<!-- OMX:AGENTS-INIT:MANUAL:START -->
## Local Notes

### 프로젝트 목적
OpenClaw, Claude Code MCP 세션, OMX 실행을 연결하는 NestJS/TypeScript 브리지 서비스.
채팅 또는 MCP 도구에서 작업을 제출하면 bridge가 `omx exec` 또는 tmux 세션으로 실행하고,
파일 기반 job state와 callback/notification 경로로 결과를 회수한다.

### 아키텍처
```
OpenClaw / Claude Code MCP / channel broker
  -> omx-bridge HTTP API
  -> omx exec 또는 tmux-backed execution
  -> job state files + notifyUrl/callback/OpenClaw/Telegram delivery
```

### 기술 스택
- Runtime: Node.js + TypeScript
- Framework: NestJS
- Queue/state: 파일 기반 JSON job store
- Long-running execution: tmux session runner
- Clients: `omx-dispatch` MCP server, `omx-bridge-plugin` OpenClaw plugin

### 운영 workflow
- Non-trivial brownfield 작업은 `analyze -> plan/ralplan -> branch 구현 -> fresh diff review -> commit/merge/push` 순서로 진행한다.
- 각 브랜치는 작고 되돌리기 쉬워야 하며, behavior fix, docs cleanup, runtime smoke, dispatch/plugin contract 변경을 한 브랜치에 섞지 않는다.
- `.omx/` runtime state, logs, historical plans는 사용자가 명시적으로 OMX state maintenance를 요청한 경우에만 편집한다.
- 자세한 workflow와 문서 map은 `docs/agent-workflow.md`를 따른다.

### 검증 기준
- 기본 검증: `npm run verify`
- Runtime/API/dispatch/plugin/callback/tmux/job lifecycle 변경: `npm run verify:runtime`
- Live OMX 검증은 operator smoke이다: `npm run verify:runtime:live`는 credentials/quota/local OMX 상태가 준비된 경우에만 실행한다.

### 주의사항
- tmux/session execution, callbacks, job state files, dispatch/plugin contract는 integration boundary로 취급한다.
- Runtime behavior 또는 live OMX behavior 변경은 unit coverage와 runtime smoke evidence 없이 진행하지 않는다.
- 새 runtime dependency는 명시 요청 없이는 추가하지 않는다.
- `contracts/bridge-job.contract.json`은 server/dispatch/plugin 계약 drift를 잡는 공유 fixture이다.
<!-- OMX:AGENTS-INIT:MANUAL:END -->
