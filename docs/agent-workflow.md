# Agent Workflow

This document is the human-readable maintenance workflow for `omx-bridge`.
The root `AGENTS.md` is the short execution contract; this file records the
repeatable workflow, branch hygiene, and verification ladder.

## Brownfield Loop

Use this loop for existing-code improvement, debugging, refactoring, runtime
smoke work, contract changes, and release-readiness refreshes.

1. Analyze read-only with file evidence, priority, confidence, and limits.
2. Convert the analysis into a staged plan with scope, risks, and tests.
3. Implement one approved stage on a branch.
4. Review only the fresh diff for bugs, regressions, and missing tests.
5. Fix review findings if any.
6. Commit, merge to `develop`, push, then report the next stage.

## Branch Rules

- Start non-trivial work from clean `develop`.
- Keep each branch small and reversible.
- Do not mix behavior fixes, documentation cleanup, runtime smoke changes,
  dispatch/plugin contract changes, and harness refactors in one branch.
- Do not mix bridge-local documentation remediation with `agent-harness`
  metadata, preset, or template changes. Use a separate branch in each
  repository.
- Check `git status --short --branch` before broad edits, commits, merges, or
  release-gate work.
- Do not edit `.omx/` runtime state, logs, or historical plans unless the task
  explicitly asks for OMX state maintenance.

## Scope Rules

- Preserve bridge runtime behavior unless the task explicitly asks for a
  behavior change.
- Treat tmux/session execution, callbacks, job state files, dispatch MCP tools,
  OpenClaw plugin behavior, and shared contract fixtures as integration
  boundaries.
- Do not add new runtime dependencies without explicit approval.
- Do not change live OMX behavior without unit coverage and runtime smoke
  evidence.
- Keep `contracts/bridge-job.contract.json` aligned with job payload, session
  summary, status, execution error, and routing field changes.

## Harness Sync Gates

When applying generated agent surfaces or `agent-harness` output to this
repository, treat `AGENTS.md` as handwritten target-local guidance unless a
separate migration plan proves otherwise.

Before any write:

- review generated output with a dry run
- inspect the existing `AGENTS.md`
- verify the `<!-- OMX:AGENTS-INIT:MANUAL:START -->` and
  `<!-- OMX:AGENTS-INIT:MANUAL:END -->` markers remain preserved
- confirm the Korean local notes inside the manual block remain preserved
- reject generated output that points at harness-only docs, prompt seeds,
  helper files, or target-local paths that do not exist in `omx-bridge`
- identify the relevant bridge verification lane before accepting the change
- record unresolved risks as `PENDING` until they are actually checked

Stop instead of syncing when the dry-run output has not been reviewed, when
manual-note preservation is uncertain, when generated output references files
that will not exist in this repository, or when the required target verification
is unknown.

## Verification Ladder

Use the smallest meaningful subset while developing, then run the relevant
full gate before claiming completion.

- Documentation-only changes: `git diff --check`.
- Standard code changes: `npm run verify`.
- Runtime/API/dispatch/plugin/callback/tmux/job lifecycle changes:
  `npm run verify:runtime` after the relevant build/test gate.
- Live OMX validation: `npm run verify:runtime:live` only when local model
  credentials, quota, and OMX installation are intentionally being exercised.

`verify:runtime:live` is an operator smoke, not a deterministic CI or merge
gate.

## Documentation Map

Use [README.md](README.md) as the canonical docs index. Keep this workflow file
focused on maintenance sequence, scope rules, and verification ladder details.

## Checkpoints

Create a checkpoint before compaction, handoff, long pauses, or switching from
analysis/planning into implementation on a complex task.

A useful checkpoint includes:

- current repository and branch
- active task goal
- completed work
- remaining work
- next single step
- changed files, if any
- verification already run
- verification still needed
- known risks and assumptions
