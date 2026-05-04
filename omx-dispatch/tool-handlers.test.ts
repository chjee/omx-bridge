import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDispatchToolHandlers,
  JOB_STATUS_VALUES,
  type BridgeJob,
  type CallbackJobInput,
  type DispatchToolDependencies,
  type JobStatus,
  type BridgeJobSession,
  type SubmitJobInput,
  type WaitForJobOptions,
} from "./tool-handlers.js";

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? "job-1",
    prompt: overrides.prompt ?? "run",
    queueOrder: overrides.queueOrder ?? "0001",
    status: overrides.status ?? "succeeded",
    createdAt: overrides.createdAt ?? "2026-04-30T00:00:00.000Z",
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt ?? "2026-04-30T00:00:01.000Z",
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? "ok",
    stderr: overrides.stderr ?? "",
    execution: overrides.execution ?? {
      command: "omx",
      timeoutMs: 1000,
      maxOutputChars: 1000,
    },
  };
}

function createJobSession(overrides: Partial<BridgeJobSession> = {}): BridgeJobSession {
  return {
    jobId: overrides.jobId ?? "job-1",
    jobStatus: overrides.jobStatus ?? "running",
    executionMode: overrides.executionMode ?? "tmux",
    attachCommand: overrides.attachCommand ?? "tmux attach -t omx-bridge-job-1",
    session: overrides.session ?? {
      backend: "tmux",
      sessionName: "omx-bridge-job-1",
      status: "running",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:01.000Z",
      attachCommand: "tmux attach -t omx-bridge-job-1",
    },
  };
}

function parseTextResult(result: { content: Array<{ type: "text"; text: string }> }): unknown {
  assert.equal(result.content[0]?.type, "text");
  return JSON.parse(result.content[0]?.text ?? "");
}

function asJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function createDeps(): {
  deps: DispatchToolDependencies;
  calls: {
    submitted: SubmitJobInput[];
    waited: Array<{ jobId: string; options?: WaitForJobOptions }>;
    listed: Array<JobStatus | undefined>;
    sessions: string[];
    callbacks: CallbackJobInput[];
    statsPreviewCounts: Array<number | undefined>;
  };
} {
  const calls = {
    submitted: [] as SubmitJobInput[],
    waited: [] as Array<{ jobId: string; options?: WaitForJobOptions }>,
    listed: [] as Array<JobStatus | undefined>,
    sessions: [] as string[],
    callbacks: [] as CallbackJobInput[],
    statsPreviewCounts: [] as Array<number | undefined>,
  };

  return {
    calls,
    deps: {
      config: {
        jobStatusValues: JOB_STATUS_VALUES,
        maxWaitTimeoutMs: 3_600_000,
        minWaitPollIntervalMs: 250,
        maxWaitPollIntervalMs: 10_000,
        notificationPreviewMax: 20,
      },
      submitBridgeJob: async (input) => {
        calls.submitted.push(input);
        return { jobId: "job-1", status: "queued" };
      },
      getBridgeJob: async (jobId) => createJob({ id: jobId }),
      getBridgeJobSession: async (jobId) => {
        calls.sessions.push(jobId);
        return createJobSession({ jobId });
      },
      waitForJobCompletion: async (jobId, options) => {
        calls.waited.push({ jobId, options });
        const job = createJob({ id: jobId });
        return {
          jobId,
          status: job.status,
          completed: true,
          timedOut: false,
          notification: null,
          job,
        };
      },
      listBridgeJobs: async (status) => {
        calls.listed.push(status);
        return [createJob({ status: status ?? "succeeded" })];
      },
      cancelBridgeJob: async (jobId) => createJob({ id: jobId, status: "cancelled" }),
      callbackBridgeJob: async (input) => {
        calls.callbacks.push(input);
        return createJob({ id: input.jobId, status: input.status, stdout: input.stdout });
      },
      drainNotifications: async () => [
        { receivedAt: "2026-04-30T00:00:02.000Z", job: createJob({ id: "job-2" }) },
      ],
      getDispatchHealth: async () => ({
        bridge: {
          reachable: true,
          url: "http://127.0.0.1:3992",
        },
        notifications: {
          pending: 0,
          dropped: 0,
          storePath: "/tmp/notifications.jsonl",
          storeBytes: 0,
          oldestEnqueuedAt: null,
        },
      }),
      getNotificationStats: async (previewCount) => {
        calls.statsPreviewCounts.push(previewCount);
        return {
          pending: 0,
          dropped: 0,
          storePath: "/tmp/notifications.jsonl",
          storeBytes: 0,
          oldestEnqueuedAt: null,
        };
      },
    },
  };
}

function toolRequest(name: string, args: Record<string, unknown> = {}): unknown {
  return {
    params: {
      name,
      arguments: args,
    },
  };
}

test("lists dispatch MCP tools with configured bounds", async () => {
  const { deps } = createDeps();
  const handlers = createDispatchToolHandlers(deps);

  const { tools } = await handlers.listTools();
  const toolRecords = tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;

  assert.deepEqual(toolRecords.map((tool) => tool.name), [
    "omx_submit_job",
    "omx_submit_job_and_wait",
    "omx_get_job",
    "omx_get_job_session",
    "omx_wait_for_job",
    "omx_list_jobs",
    "omx_cancel_job",
    "omx_callback_job",
    "omx_get_notifications",
    "omx_health",
    "omx_notification_stats",
  ]);

  const waitTool = toolRecords.find((tool) => tool.name === "omx_wait_for_job");
  assert.deepEqual(waitTool?.inputSchema.properties["waitTimeoutMs"], {
    type: "number",
    minimum: 1,
    maximum: 3_600_000,
    description: "Maximum time to wait for this job to complete. Defaults to OMX_DISPATCH_WAIT_TIMEOUT_MS or 300000.",
  });
});

test("submits a job and waits without leaking wait options into the submit payload", async () => {
  const { deps, calls } = createDeps();
  const handlers = createDispatchToolHandlers(deps);

  const result = await handlers.callTool(toolRequest("omx_submit_job_and_wait", {
    prompt: "build it",
    executionMode: "tmux",
    cwd: "/workspace/project",
    source: "dispatch",
    waitTimeoutMs: 1234,
    pollIntervalMs: 500,
  }));

  assert.deepEqual(calls.submitted, [
    {
      prompt: "build it",
      executionMode: "tmux",
      cwd: "/workspace/project",
      source: "dispatch",
    },
  ]);
  assert.deepEqual(calls.waited, [
    {
      jobId: "job-1",
      options: {
        waitTimeoutMs: 1234,
        pollIntervalMs: 500,
      },
    },
  ]);
  assert.equal((parseTextResult(result) as { jobId: string }).jobId, "job-1");
});

test("routes session, list, callback, notifications, and stats tools through injected dependencies", async () => {
  const { deps, calls } = createDeps();
  const handlers = createDispatchToolHandlers(deps);

  assert.deepEqual(
    parseTextResult(await handlers.callTool(toolRequest("omx_get_job_session", { jobId: "job-session" }))),
    asJsonValue(createJobSession({ jobId: "job-session" })),
  );
  assert.deepEqual(calls.sessions, ["job-session"]);

  assert.deepEqual(
    parseTextResult(await handlers.callTool(toolRequest("omx_list_jobs", { status: "failed" }))),
    asJsonValue([createJob({ status: "failed" })]),
  );
  assert.deepEqual(calls.listed, ["failed"]);

  assert.equal(
    (parseTextResult(await handlers.callTool(toolRequest("omx_callback_job", {
      jobId: "job-3",
      status: "cancelled",
      stdout: "stopped",
      exitCode: null,
    }))) as BridgeJob).status,
    "cancelled",
  );
  assert.deepEqual(calls.callbacks, [
    {
      jobId: "job-3",
      status: "cancelled",
      stdout: "stopped",
      exitCode: null,
    },
  ]);

  assert.deepEqual(parseTextResult(await handlers.callTool(toolRequest("omx_get_notifications"))), {
    count: 1,
    notifications: asJsonValue([
      { receivedAt: "2026-04-30T00:00:02.000Z", job: createJob({ id: "job-2" }) },
    ]),
  });

  await handlers.callTool(toolRequest("omx_notification_stats", { previewCount: Number.NaN }));
  assert.deepEqual(calls.statsPreviewCounts, [0]);
});

test("rejects unknown tools", async () => {
  const { deps } = createDeps();
  const handlers = createDispatchToolHandlers(deps);

  await assert.rejects(
    () => handlers.callTool(toolRequest("omx_missing")),
    /Unknown tool: omx_missing/,
  );
});
