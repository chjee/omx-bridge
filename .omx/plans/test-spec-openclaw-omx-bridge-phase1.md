# Test Spec: OpenClaw → OMX Exec Bridge (Phase 1)

Date: 2026-04-02
Related plan: `.omx/plans/prd-openclaw-omx-bridge-phase1.md`

## Test Objectives

Validate the first operational bridge slice described in the local roadmap: OpenClaw submits work, the bridge persists a file-backed job, an in-process worker runs `omx exec`, and the result is retrievable (`AGENTS.md:399-404`).

## Test Matrix

### Unit tests

#### 1. DTO validation
Target: `src/jobs/dto/create-job.dto.ts`
- Reject empty prompt.
- Reject overly long prompt if a max length is configured.
- Accept minimal valid payload.
- Preserve optional metadata fields.

#### 2. File queue repository
Target: `src/jobs/job-queue.repository.ts`
- Creates queue directory if missing.
- Writes a new `<jobId>.json` file with `queued` status.
- Reads a job by id.
- Updates status/result fields without dropping existing fields.
- Lists queued jobs in deterministic FIFO order.
- Handles malformed/missing job files predictably.

#### 3. OMX execution wrapper
Target: `src/jobs/omx-exec.service.ts`
- Invokes the configured OMX binary with the expected `exec` argument shape.
- Maps stdout/stderr/exitCode into a normalized result object.
- Maps timeout into a failure result.
- Maps missing-binary (`ENOENT`) into a failure result.
- Enforces output truncation policy if configured.

#### 4. FIFO runner
Target: `src/jobs/job-runner.service.ts`
- Picks oldest queued job first.
- Never runs more than one job at a time.
- Marks a job `running` before execution.
- Marks success terminal state on zero exit.
- Marks failure terminal state on non-zero exit.
- Recovers stranded `running` jobs according to the documented startup policy.

### Integration / e2e tests

#### 5. Submit → run → poll success path
Targets: `src/jobs/jobs.controller.ts`, `src/jobs/jobs.service.ts`, runner integration
- `POST /jobs` returns `202` and `jobId`.
- Job file exists on disk immediately after submit.
- Worker completes the job.
- `GET /jobs/:id` eventually returns `succeeded`.
- Response includes persisted stdout and exit code.

#### 6. Submit → run → poll failure path
- Mock/stub OMX to exit non-zero.
- `GET /jobs/:id` eventually returns `failed`.
- Persisted stderr/exitCode are visible.
- Bridge process remains healthy and can accept another job.

#### 7. FIFO ordering
- Submit at least 3 jobs quickly.
- Verify they complete in created order.
- Verify only one job is `running` at a time.

#### 8. Restart recovery
- Seed a `running` job file before app bootstrap.
- Start the app.
- Verify the configured recovery rule is applied consistently.

## Test Fixtures / Harness

- Prefer mocking child-process execution for unit tests.
- For e2e, use a configurable fake OMX binary/script path to avoid depending on the real CLI for every test.
- Reserve one manual smoke test against the real `omx` binary after automated tests pass.

## Manual Verification

1. Start the bridge locally.
2. Submit a real prompt with curl or HTTPie.
3. Inspect the JSON job file under the queue directory.
4. Poll the job endpoint until completion.
5. Confirm stdout/stderr persistence and terminal status.
6. Kill/restart the app during a queued/running job and verify the restart policy.

## Exit Criteria

- All unit tests pass.
- All e2e tests pass.
- Manual smoke test with a real `omx exec` prompt succeeds.
- Failure-path manual smoke test produces persisted error details without crashing the service.
