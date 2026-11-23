<!-- Generated from agent-harness. Edit source templates or rerun sync-project.sh. -->

# AGENTS.md Base

You are a coding agent working inside this repository.

## Operating Contract

Follow the shared operating principles, verification rules, and git hygiene
sections in this file before applying Codex-specific behavior.

## Codex-Specific Rules

- Use repository instructions from deeper `AGENTS.md` files when present.
- Prefer `rg` for search and focused shell commands for inspection.
- Use Plan mode for requirements discovery and implementation planning.
- Use Default mode for implementation and verification.
- Use native subagents only for bounded independent work that can run in
  parallel.
- Do not use long-running orchestration unless the task benefits from it.

## OMX Notes

OMX is an optional orchestration layer over Codex. Use it for durable workflows
such as planning, team execution, HUD/status, tmux-managed sessions, and
runtime state. Plain Codex usage does not require the OMX harness.

# Operating Principles

- Solve the stated task directly when the scope is clear.
- Ask only when the next step is destructive, irreversible, credentialed, or
  materially changes direction.
- When ambiguity affects the correct path, surface plausible interpretations,
  inconsistencies, and trade-offs before choosing.
- Prefer existing project patterns over new abstractions.
- Push back when a simpler or safer approach better fits the stated goal.
- Keep diffs small, reviewable, and reversible.
- Do not rewrite unrelated code, comments, or formatting that the task does not
  require.
- Do not hide uncertainty. Mark assumptions, risks, and unverified claims.
- Use evidence from the repository before making architectural claims.
- Do not edit `.omx/` runtime state, logs, or historical plans unless the task
  explicitly asks for OMX state maintenance.
- Stop only when the task is complete, blocked, or explicitly cancelled.

## Language Preferences

- When the user writes in Korean, respond in Korean by default.
- Keep file paths, symbols, commands, API names, stack traces, quoted source
  text, and exact error messages unchanged.
- If an upstream tool or delegated agent returns English output, translate and
  synthesize the user-facing report into Korean instead of forwarding raw
  English text.

# Verification

- Identify declarative, testable completion evidence before editing.
- Run the smallest meaningful verification for the change.
- For behavior changes, prefer tests over manual inspection.
- For refactors, lock existing behavior before changing structure.
- If verification fails, fix and rerun instead of reporting partial success.
- Final reports should include changed files, verification performed, and
  remaining risks.

## Default Verification Ladder

1. Static check for touched files.
2. Relevant unit tests.
3. Typecheck or build.
4. Integration or smoke test when behavior crosses module boundaries.

# Git Rules

- Never revert user changes unless explicitly asked.
- Check worktree status before broad edits or commits.
- Keep unrelated cleanup out of task branches.
- Commit messages should explain why the change exists, not restate the diff.
- Include verification evidence in the commit body when useful.
- Include `Co-authored-by: OmX <omx@oh-my-codex.dev>` for agent-authored
  commits when the repository expects OmX attribution.

## Commit Trailer Hints

Use native git trailers when they add value:

- `Constraint:`
- `Rejected:`
- `Confidence:`
- `Scope-risk:`
- `Tested:`
- `Not-tested:`

# chjee Operating Preferences

- Treat the harness as a quality gate, not a substitute for planning.
- For unclear work, force requirements discovery before execution.
- Prefer durable templates and reusable scripts over one-off manual prompts.
- Bias toward small, reversible increments with explicit validation evidence.
- For long-running agent work, capture checkpoints before compaction or handoff.
- For existing code, preserve behavior first; cleanup follows tests.
- Avoid token-heavy loops when goals, boundaries, or stop conditions are weak.
- Final reports should be concise and include what changed, what was verified,
  and what remains risky.

# Brownfield Improvement Workflow

Use for existing-code improvement, debugging, refactoring, or cleanup when the
correct change is not obvious yet.

## Sequence

1. Analyze read-only: evidence files, priority, confidence, and limits.
2. Plan from the analysis: staged scope, risks, and test criteria.
3. Implement only the first approved step on a branch when non-trivial.
4. Review only the fresh diff for bugs, regressions, and missing tests.
5. Checkpoint before compaction, handoff, or long pauses.

## Guardrails

- Do not edit during analysis.
- Keep plans bounded to repository evidence.
- Do not make out-of-scope changes during implementation.
- Prefer existing code style and local patterns.
- Add abstractions or structural changes only when necessary.
- For broad review or QA, split independent evidence-gathering lanes only when
  each lane has a bounded question and a clear synthesis point.
- For generate-then-review loops, define the review criteria before revising the
  output so feedback does not drift into unrelated cleanup.
- Use `$security-review` for security-sensitive boundaries.

# Refactor Profile

Use this profile for cleanup, simplification, and structure changes.

- Behavior changes are out of scope unless explicitly requested.
- Write a cleanup plan before editing.
- Run existing tests before changes when feasible.
- Add regression tests first if behavior is not protected.
- Prefer deletion and reuse over new layers.
- Work one smell or boundary at a time.
- Final report must list simplifications, changed files, verification, and
  remaining risks.

# Node.js Stack Overlay

- Prefer the package manager already used by the repository.
- Inspect `package.json` scripts before inventing commands.
- Run relevant `test`, `lint`, `typecheck`, or `build` scripts when available.
- Do not add dependencies without an explicit reason and user approval.
- Keep generated lockfile changes intentional.

# TypeScript Stack Overlay

- Treat `tsconfig.json` as the source of truth for module system, strictness,
  path aliases, and emit behavior.
- Run `typecheck` when present; otherwise use the repository's documented build
  or `tsc --noEmit` when appropriate.
- Preserve exported types and public DTO/API contracts unless the task requires
  a breaking change.
- Prefer typed helpers over `any`, ad hoc object mutation, or stringly typed
  control flow.
- Keep runtime validation and TypeScript types aligned.

# NestJS Stack Overlay

- Respect Nest module boundaries: controllers handle transport, services own
  domain behavior, providers encapsulate integrations.
- Check dependency injection tokens, module imports, and provider exports before
  moving code.
- Add tests with `@nestjs/testing` for provider/controller behavior when logic
  crosses a Nest boundary.
- Keep DTOs, validation pipes, guards, interceptors, and filters explicit.
- Do not start broad module rewrites unless the task is explicitly architectural.
- Prefer repository scripts such as `npm test`, `npm run test:e2e`,
  `npm run build`, and `npm run lint` when available.

# Project Overlay: omx-bridge

## Project Identity

- This is a NestJS/TypeScript bridge between OpenClaw and OMX execution.
- Treat tmux/session execution, callbacks, job state files, and plugin dispatch
  as integration boundaries.
- Keep behavior fixes, documentation cleanup, runtime smoke work,
  dispatch/plugin contract changes, and harness changes in separate branches.
- Work on `agent-harness` only when the user explicitly asks for that
  repository.

## Verification Boundaries

Verification command: `npm run verify`

- Preserve existing `npm run verify`, `npm run verify:runtime`, and smoke
  workflows when changing runtime behavior.
- Avoid changing live OMX behavior without unit coverage and runtime smoke
  evidence.
- Target documentation map: maintenance workflow is target-local project docs,
  release verification is `docs/release-verification.md`, runtime smoke is
  `docs/runtime-smoke.md`, routing contract is `docs/routing-contract.md`, and
  shared job contract guidance is `docs/contract-source-of-truth.md`.

## Target Sync Notes

- Treat the existing `omx-bridge` `AGENTS.md` as target-local unless a migration
  plan proves otherwise; before writing generated harness output, review the
  agent-harness dry-run output, inspect the existing `AGENTS.md`, preserve both
  manual block markers and Korean local notes, identify the verification lane,
  and reject output that references missing target-local paths or harness-only
  files.
- Keep runtime marker contracts stable:
  `<!-- OMX:RUNTIME:START --> ... <!-- OMX:RUNTIME:END -->`,
  `<!-- OMX:TEAM:WORKER:START --> ... <!-- OMX:TEAM:WORKER:END -->`, and
  `<!-- OMX:AGENTS-INIT:MANUAL:START --> ... <!-- OMX:AGENTS-INIT:MANUAL:END -->`.


<!-- OMX:AGENTS-INIT:MANUAL:START -->
## Local Notes

<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT. THIS IS COMPLEMENTARY TO OMX TEAM MODE.
<!-- END AUTONOMY DIRECTIVE -->

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
- 자세한 workflow와 문서 map은 루트 [README의 Architecture 절](README.md#architecture)에서 “Agent maintenance workflow” 링크를 따른다.
- 사용자가 다른 기준을 지정하지 않으면 비단순 작업은 깨끗한 `develop`에서 시작한다.
- 명시적으로 호출된 설치 스킬을 사용한다. 역할 프롬프트와 스킬은 이 저장소 계약 범위에서 적용한다.
- `$team`, `$ralph`, `$autopilot`, `$ultrawork`, `$ultraqa`는 실제 OMX 런타임에서 실행한다. 일반 Codex에서는 계획·직접 실행·네이티브 서브에이전트 중 작업에 맞는 방식을 쓴다.
- 위임 시 작업별 소유 범위를 나누고 `worker`는 활성 OMX team/swarm에서만 사용한다. 리더가 통합·최종 검증·상태 보고를 맡는다.
- 단순 읽기 전용 탐색은 사용 가능하면 `omx explore`, 그 밖에는 `rg`를 우선한다.
- 병합·릴리스 검증 전에도 `git status --short --branch`를 확인한다. 커밋에는 Lore 형식으로 해당하는 `Constraint:`, `Rejected:`, `Confidence:`, `Scope-risk:`, `Directive:`, `Tested:`, `Not-tested:`, `Related:`를 기록한다.

### 검증 기준
- 문서만 바꾸면 `git diff --check`를 실행한다.
- 기본 검증: `npm run verify`
- Runtime/API/dispatch/plugin/callback/tmux/job lifecycle 변경: 관련 빌드·테스트가 통과한 뒤 `npm run verify:runtime`을 실행한다.
- Live OMX 검증은 operator smoke이다: `npm run verify:runtime:live`는 credentials/quota/local OMX 상태가 준비된 경우에만 실행한다.

### 주의사항
- tmux/session execution, callbacks, job state files, dispatch/plugin contract는 integration boundary로 취급한다.
- Runtime behavior 또는 live OMX behavior 변경은 unit coverage와 runtime smoke evidence 없이 진행하지 않는다.
- 새 runtime dependency는 명시 요청 없이는 추가하지 않는다.
- `contracts/bridge-job.contract.json`은 server/dispatch/plugin 계약 drift를 잡는 공유 fixture이다. job payload, session summary, status, execution error, routing 필드를 바꾸면 같은 변경에서 이 파일을 갱신한다.
<!-- OMX:AGENTS-INIT:MANUAL:END -->
