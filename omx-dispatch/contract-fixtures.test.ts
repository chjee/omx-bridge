import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createDispatchToolHandlers,
  BRIDGE_EXECUTION_ERROR_TYPES,
  JOB_EXECUTION_MODE_VALUES,
  JOB_SOURCE_VALUES,
  JOB_STATUS_VALUES,
  TMUX_SESSION_STATUS_VALUES,
  type DispatchToolDependencies,
} from "./tool-handlers.js";
import { normalizeNotification, normalizeWebhookJob } from "./webhook-codec.js";

interface BridgeJobContract {
  jobStatuses: string[];
  jobExecutionModes: string[];
  executionErrorTypes: string[];
  tmuxSessionStatuses: string[];
  jobSources: string[];
  bridgeJob: Record<string, unknown>;
  bridgeJobSession: Record<string, unknown>;
}

async function loadContract(): Promise<BridgeJobContract> {
  const raw = await readFile(new URL("../../contracts/bridge-job.contract.json", import.meta.url), "utf8");
  return JSON.parse(raw) as BridgeJobContract;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefined(entry)]),
  );
}

test("dispatch contract constants match the shared bridge fixture", async () => {
  const contract = await loadContract();

  assert.deepEqual([...JOB_STATUS_VALUES], contract.jobStatuses);
  assert.deepEqual([...JOB_EXECUTION_MODE_VALUES], contract.jobExecutionModes);
  assert.deepEqual([...BRIDGE_EXECUTION_ERROR_TYPES], contract.executionErrorTypes);
  assert.deepEqual([...TMUX_SESSION_STATUS_VALUES], contract.tmuxSessionStatuses);
  assert.deepEqual([...JOB_SOURCE_VALUES], contract.jobSources);
});

test("dispatch webhook normalization preserves the full shared bridge job fixture", async () => {
  const contract = await loadContract();
  const normalized = normalizeWebhookJob(contract.bridgeJob);

  assert.deepEqual(stripUndefined(normalized), contract.bridgeJob);
  assert.deepEqual(
    stripUndefined(normalizeNotification({
      receivedAt: "2026-05-04T00:00:05.000Z",
      job: contract.bridgeJob,
    })),
    {
      receivedAt: "2026-05-04T00:00:05.000Z",
      job: contract.bridgeJob,
    },
  );
});

test("dispatch session tool returns the shared session summary fixture", async () => {
  const contract = await loadContract();
  const deps = {
    config: {
      jobStatusValues: JOB_STATUS_VALUES,
      maxWaitTimeoutMs: 3_600_000,
      minWaitPollIntervalMs: 250,
      maxWaitPollIntervalMs: 10_000,
      notificationPreviewMax: 20,
    },
    submitBridgeJob: async () => ({ jobId: "unused", status: "queued" }),
    getBridgeJob: async () => contract.bridgeJob,
    getBridgeJobSession: async () => contract.bridgeJobSession,
    waitForJobCompletion: async () => ({
      jobId: String(contract.bridgeJobSession["jobId"]),
      status: "failed",
      completed: true,
      timedOut: false,
      notification: null,
      job: contract.bridgeJob,
    }),
    listBridgeJobs: async () => [contract.bridgeJob],
    cancelBridgeJob: async () => contract.bridgeJob,
    callbackBridgeJob: async () => contract.bridgeJob,
    drainNotifications: async () => [],
    getDispatchHealth: async () => ({
      bridge: { reachable: true, url: "http://127.0.0.1:3992" },
      notifications: {
        pending: 0,
        dropped: 0,
        storePath: "/tmp/notifications.jsonl",
        storeBytes: 0,
        oldestEnqueuedAt: null,
      },
    }),
    getNotificationStats: async () => ({
      pending: 0,
      dropped: 0,
      storePath: "/tmp/notifications.jsonl",
      storeBytes: 0,
      oldestEnqueuedAt: null,
    }),
  } as unknown as DispatchToolDependencies;
  const handlers = createDispatchToolHandlers(deps);

  const result = await handlers.callTool({
    params: {
      name: "omx_get_job_session",
      arguments: { jobId: contract.bridgeJobSession["jobId"] },
    },
  });

  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), contract.bridgeJobSession);
});
