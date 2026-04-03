# PRD: OpenClaw → OMX Exec Bridge (Phase 1, file-based queue)

Date: 2026-04-02
Status: Drafted via `$plan`

## Requirements Summary

### Grounded context
- The project goal is to connect OpenClaw (Telegram AI assistant) and OMX (coding agent) through a bridge service so Telegram coding requests can trigger OMX and return results (`AGENTS.md:384-386`).
- The target high-level architecture is `Telegram(앤디) → OpenClaw → Bridge Service → OMX exec → 결과 반환` (`AGENTS.md:388-391`).
- The preferred stack is Node.js + TypeScript + NestJS, with a file-based queue using JSON files and tmux reserved for longer-running work later (`AGENTS.md:393-397`).
- The staged roadmap explicitly starts with single-run `omx exec` integration first, then state persistence, result polling, tmux session management, and finally team mode (`AGENTS.md:399-404`).
- The repository currently contains only `AGENTS.md`; no NestJS app or bridge code exists yet (repo inspection on 2026-04-02).
- Headless OMX execution is the main adapter concern, the solution should be grown incrementally, and bot-loop prevention matters when wiring this into chat systems (`AGENTS.md:414-417`).

### Phase-1 scope decision
To make a file-based queue operational on day 1, Phase 1 should slightly pull forward the thinnest possible job-status read path while still staying focused on single-run `omx exec` execution:
1. Accept a task request from OpenClaw over HTTP.
2. Persist it as a JSON job file in a local queue directory.
3. Process queued jobs serially in-process by invoking `omx exec`.
4. Persist stdout/stderr/exit code/status back into the job JSON.
5. Expose a minimal read endpoint so OpenClaw can poll for completion.

This keeps tmux/team features out of scope, but avoids building a queue that has no usable completion path.

## Acceptance Criteria

1. A NestJS service boots locally and exposes an HTTP API for job submission.
2. `POST /jobs` (or equivalent) accepts a prompt payload from OpenClaw, validates it, creates a job id, and writes a JSON job record to disk before execution starts.
3. Jobs are stored under a deterministic local directory (recommended: `.omx/state/bridge-jobs/`) using one JSON file per job.
4. A background in-process worker detects `queued` jobs and processes them one at a time in FIFO order.
5. The worker invokes `omx exec <prompt>` via Node child-process APIs without requiring interactive stdin.
6. Job files transition through explicit statuses such as `queued`, `running`, `succeeded`, and `failed`.
7. On completion, each job file contains at minimum: `id`, `prompt`, `status`, `createdAt`, `startedAt`, `finishedAt`, `exitCode`, `stdout`, `stderr`, and execution metadata.
8. A read endpoint such as `GET /jobs/:id` returns the current persisted job state for polling.
9. Failed `omx exec` invocations do not crash the bridge process; the failure is captured in the job file and API response.
10. The implementation has automated tests for payload validation, queue persistence, queue ordering, and `omx exec` success/failure handling.

## Proposed File Layout

Because the repo is empty today, Phase 1 should create only the minimum app skeleton and bridge-focused modules:

- `package.json` — scripts and NestJS dependencies
- `tsconfig.json` — TS compiler settings
- `nest-cli.json` — Nest CLI config (optional but conventional)
- `src/main.ts` — Nest bootstrap
- `src/app.module.ts` — root module
- `src/config/env.ts` or `src/config/configuration.ts` — queue path / omx binary / timeouts
- `src/jobs/jobs.module.ts` — jobs domain module
- `src/jobs/jobs.controller.ts` — submit + read endpoints
- `src/jobs/jobs.service.ts` — orchestration layer for submission and status reads
- `src/jobs/job-queue.repository.ts` — file-based JSON persistence
- `src/jobs/job-runner.service.ts` — in-process FIFO runner
- `src/jobs/omx-exec.service.ts` — child-process wrapper around `omx exec`
- `src/jobs/dto/create-job.dto.ts` — request validation
- `test/jobs.e2e-spec.ts` — API/queue lifecycle verification
- `test/unit/*.spec.ts` — targeted unit tests for repository/runner/executor

## Implementation Steps

### 1. Bootstrap the minimal NestJS service
Create the base Node.js/TypeScript/NestJS application skeleton aligned with the stack declared in `AGENTS.md:393-397`.

Concrete work:
- Initialize `package.json` with build/start/test scripts.
- Add the minimum NestJS packages needed for HTTP + validation + testing.
- Create `src/main.ts` and `src/app.module.ts`.
- Enable request validation globally so malformed OpenClaw payloads fail early.

Definition of done:
- `npm run start:dev` (or equivalent) boots a local Nest server.

### 2. Define the bridge job model and on-disk queue contract
Introduce a stable JSON schema for queued work before writing controller or worker logic.

Concrete work:
- Define a `JobStatus` enum/type: `queued | running | succeeded | failed`.
- Define a `BridgeJob` interface/type with request, timing, and result fields.
- Choose the queue directory location. Recommended: `.omx/state/bridge-jobs/` so the bridge stays colocated with OMX runtime state conventions (`AGENTS.md:358-364`).
- Use one file per job: `<jobId>.json`.
- Persist atomically by writing temp file then renaming, or by using safe whole-file rewrites.

Definition of done:
- A repository service can create, read, list, and update job JSON files deterministically.

### 3. Build the HTTP submission and polling API
Expose the smallest API surface OpenClaw needs.

Concrete work:
- `POST /jobs`: validate input, create a queued job, persist it, and return `202 Accepted` with `jobId`.
- `GET /jobs/:id`: return the latest persisted job state for polling.
- Keep the request DTO narrow for Phase 1, e.g. `prompt`, optional `requestId`, optional `metadata`.

Definition of done:
- OpenClaw can submit a prompt and later poll by id.

### 4. Implement the in-process FIFO worker
Use a single-process runner instead of tmux or distributed workers because Phase 1 is explicitly scoped to simple single-run `omx exec` integration (`AGENTS.md:399-404`).

Concrete work:
- Start a polling loop or internal queue tick on application bootstrap.
- Load queued jobs from disk and pick the oldest pending job first.
- Mark the job `running` before invoking OMX.
- Ensure only one job runs at a time in this phase.
- On startup, recover any stranded `running` jobs by either resetting them to `queued` or marking them failed with a restart reason; choose and document one policy.

Definition of done:
- Multiple submitted jobs are processed in persisted FIFO order without overlap.

### 5. Wrap `omx exec` safely
Implement a dedicated service for the bridge-to-OMX adapter because the local notes identify headless OMX execution as the main risk (`AGENTS.md:414-416`).

Concrete work:
- Use `child_process.spawn` or `execFile` rather than shell string concatenation.
- Make the OMX binary path configurable (`omx` by default).
- Capture stdout, stderr, exit code, and timeout conditions.
- Pass the task prompt as a single argument compatible with `omx exec "작업내용"` (`AGENTS.md:406-409`).
- Normalize process outcomes into bridge job result fields.

Definition of done:
- Success, non-zero exit, missing binary, and timeout paths all produce deterministic persisted outcomes.

### 6. Add operational safeguards
Keep the first implementation small, but not brittle.

Concrete work:
- Add structured logs for job lifecycle events.
- Validate queue directory creation on boot.
- Add configurable execution timeout and max captured output size.
- Reject empty prompts and optionally cap prompt length for Phase 1.
- Reserve mention-loop prevention for the OpenClaw integration layer, but leave a metadata field so upstream can pass source identifiers (`AGENTS.md:417`).

Definition of done:
- The service fails predictably and remains debuggable during local testing.

### 7. Verify with unit and e2e tests
Protect the behavior before moving to tmux/team-mode phases.

Concrete work:
- Unit-test the repository create/update/reload behavior.
- Unit-test FIFO selection and restart recovery behavior.
- Unit-test OMX execution result mapping with mocked child processes.
- E2E-test the submit→run→poll success path.
- E2E-test the submit→run→poll failure path.

Definition of done:
- Core job lifecycle behavior is enforced by automated tests.

## Recommended Technical Decisions

### Queue storage
- **Choose:** JSON files on local disk.
- **Why:** Matches the declared project direction (`AGENTS.md:396`), keeps the first phase dependency-free, and makes inspection/debugging easy.
- **Not yet:** SQLite/Redis/message brokers.

### Concurrency model
- **Choose:** single in-process worker, FIFO, one active job at a time.
- **Why:** It matches the “step-by-step” guidance (`AGENTS.md:416`) and minimizes race conditions in the first bridge cut.
- **Not yet:** parallel workers, distributed locks, tmux-backed long sessions.

### API contract
- **Choose:** async job submission + polling.
- **Why:** `omx exec` can be slow/unpredictable, so holding the POST request open is fragile.
- **Not yet:** websocket push, callbacks, streaming token output.

## Risks and Mitigations

1. **Risk:** `omx exec` may behave differently in headless/non-interactive execution.
   - **Mitigation:** isolate execution in `omx-exec.service.ts`, add timeout/error mapping, and verify locally with a known prompt first.

2. **Risk:** File writes can corrupt job state on crash.
   - **Mitigation:** use atomic rewrite semantics and write status transitions explicitly.

3. **Risk:** Worker restarts can leave ambiguous `running` jobs behind.
   - **Mitigation:** define startup recovery policy and cover it with tests.

4. **Risk:** Queue ordering can break if multiple writes happen quickly.
   - **Mitigation:** persist `createdAt`, sort deterministically, and keep one worker in Phase 1.

5. **Risk:** Large stdout/stderr payloads can bloat JSON files.
   - **Mitigation:** cap captured output and record truncation metadata.

## Verification Steps

1. Install dependencies and boot the NestJS app.
2. Submit a sample job via `POST /jobs`.
3. Confirm a JSON file is created under the configured queue directory.
4. Confirm the worker transitions the file from `queued` → `running` → terminal status.
5. Poll `GET /jobs/:id` until completion and verify persisted stdout/stderr/exitCode.
6. Run unit and e2e tests.
7. Run a negative-path test where `omx` is missing or returns non-zero.

## Out of Scope for Phase 1

- tmux-based long-running session ownership (`AGENTS.md:397`, `AGENTS.md:403`)
- OMX team mode integration (`AGENTS.md:404`)
- parallel multi-worker execution
- push notifications / callbacks / websocket streaming
- Telegram-side mention filtering and loop prevention logic

## Suggested execution order after planning

1. Scaffold NestJS project.
2. Implement file repository + job types.
3. Implement controller/service API.
4. Implement FIFO runner.
5. Implement OMX execution wrapper.
6. Add tests.
7. Run end-to-end local verification with a real `omx exec` call.
