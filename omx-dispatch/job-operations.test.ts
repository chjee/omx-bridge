import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeHttpError } from "./bridge-client.js";
import { CallbackConflictError, JobOperations, type JobOperationsConfig } from "./job-operations.js";
import { NotificationStore, type JobNotification, type NotificationStats } from "./notification-store.js";
import type { BridgeJob, JobStatus } from "./tool-handlers.js";
import { normalizeNotification } from "./webhook-codec.js";

interface CapturedRequest {
  path: string;
  init?: RequestInit;
  signatureHeader?: string;
}

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? "job-1",
    prompt: overrides.prompt ?? "run",
    queueOrder: overrides.queueOrder ?? "0001",
    status: overrides.status ?? "running",
    createdAt: overrides.createdAt ?? "2026-04-30T00:00:00.000Z",
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt,
    exitCode: overrides.exitCode ?? null,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    execution: overrides.execution ?? {
      command: "omx",
      timeoutMs: 1000,
      maxOutputChars: 1000,
    },
  };
}

function createNotification(job: BridgeJob): JobNotification<BridgeJob> {
  return {
    receivedAt: "2026-04-30T00:00:01.000Z",
    job,
  };
}

function createStats(): NotificationStats<JobStatus> {
  return {
    pending: 0,
    dropped: 0,
    storePath: "/tmp/notifications.jsonl",
    storeBytes: 0,
    oldestEnqueuedAt: null,
  };
}

function createOperations(overrides: {
  requestJson?: (path: string, init?: RequestInit, signatureHeader?: string) => Promise<unknown>;
  drainNotificationForJob?: (jobId: string) => Promise<JobNotification<BridgeJob> | null>;
  getNotificationStats?: (previewCount?: number) => Promise<NotificationStats<JobStatus>>;
  defaultNotifyUrl?: () => string;
  callbackSecret?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): {
  operations: JobOperations;
  requests: CapturedRequest[];
  sleeps: number[];
} {
  const requests: CapturedRequest[] = [];
  const sleeps: number[] = [];
  const config: JobOperationsConfig = {
    bridgeUrl: "http://127.0.0.1:3992",
    callbackSecret: overrides.callbackSecret ?? "",
    defaultNotifyUrl: overrides.defaultNotifyUrl ?? (() => "http://127.0.0.1:12000/notify"),
    defaultWaitTimeoutMs: 5_000,
    defaultWaitPollIntervalMs: 1_000,
    maxWaitTimeoutMs: 10_000,
    minWaitPollIntervalMs: 250,
    maxWaitPollIntervalMs: 2_000,
    terminalNotificationGraceMs: 500,
  };
  const operations = new JobOperations(config, {
    bridgeClient: {
      requestJson: async <T>(path: string, init?: RequestInit, signatureHeader?: string): Promise<T> => {
        requests.push({ path, init, signatureHeader });
        return (overrides.requestJson
          ? await overrides.requestJson(path, init, signatureHeader)
          : createJob()) as T;
      },
    },
    getNotificationStats: overrides.getNotificationStats ?? (async () => createStats()),
    drainNotificationForJob: overrides.drainNotificationForJob ?? (async () => null),
    buildCallbackSignatureHeader: (jobId, body) => `sig:${jobId}:${body}`,
    describeError: (error) => error instanceof Error ? error.message : String(error),
    sleep: overrides.sleep ?? (async (ms) => {
      sleeps.push(ms);
    }),
    now: overrides.now,
  });

  return { operations, requests, sleeps };
}

test("classifies callback-only HTTP 409 responses as typed conflicts", async () => {
  const details = { statusCode: 409, message: "stored terminal result differs" };
  const { operations } = createOperations({
    requestJson: async (path) => {
      if (path.endsWith("/callback")) throw new BridgeHttpError(409, "Conflict", details);
      throw new BridgeHttpError(409, "Conflict", { message: "generic conflict" });
    },
  });

  await assert.rejects(
    () => operations.callbackBridgeJob({ jobId: "job-1", status: "failed" }),
    (error: unknown) => error instanceof CallbackConflictError && error.status === 409 && error.details === details,
  );
  await assert.rejects(
    () => operations.cancelBridgeJob("job-1"),
    (error: unknown) => error instanceof BridgeHttpError && !(error instanceof CallbackConflictError),
  );
});

test("submits jobs with the session notify URL when no explicit notify URL is supplied", async () => {
  const { operations, requests } = createOperations({
    requestJson: async () => ({ jobId: "job-1", status: "queued" }),
  });

  await operations.submitBridgeJob({
    prompt: "build",
    executionMode: "tmux",
    cwd: "/workspace/project",
    requestId: "req-1",
    originRoutingKey: "telegram:direct:123",
    metadata: { chat: 123 },
    source: "dispatch",
    sourceName: "omx-dispatch",
  });

  assert.equal(requests[0]?.path, "jobs");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    prompt: "build",
    executionMode: "tmux",
    cwd: "/workspace/project",
    requestId: "req-1",
    originRoutingKey: "telegram:direct:123",
    metadata: { chat: 123 },
    source: "dispatch",
    sourceName: "omx-dispatch",
    notifyUrl: "http://127.0.0.1:12000/notify",
  });
});

test("uses explicit notify URL instead of the session default", async () => {
  const { operations, requests } = createOperations({
    requestJson: async () => ({ jobId: "job-1", status: "queued" }),
  });

  await operations.submitBridgeJob({
    prompt: "route elsewhere",
    notifyUrl: "http://127.0.0.1:3994/notify",
  });

  assert.equal(JSON.parse(String(requests[0]?.init?.body)).notifyUrl, "http://127.0.0.1:3994/notify");
});

test("builds bridge job list, session, cancel, and callback requests", async () => {
  const { operations, requests } = createOperations({
    callbackSecret: "secret",
    requestJson: async () => createJob({ status: "cancelled" }),
  });

  await operations.listBridgeJobs("failed");
  await operations.getBridgeJobSession("job/1");
  await operations.cancelBridgeJob("job/1");
  await operations.callbackBridgeJob({
    jobId: "job/1",
    status: "cancelled",
    stdout: "stopped",
    exitCode: null,
  });

  assert.equal(requests[0]?.path, "jobs?status=failed");
  assert.deepEqual(requests[1], {
    path: "jobs/job%2F1/session",
    init: { method: "GET" },
    signatureHeader: undefined,
  });
  assert.deepEqual(requests[2], {
    path: "jobs/job%2F1/cancel",
    init: { method: "POST" },
    signatureHeader: undefined,
  });
  assert.equal(requests[3]?.path, "jobs/job%2F1/callback");
  assert.equal(requests[3]?.signatureHeader, "sig:job/1:{\"status\":\"cancelled\",\"stdout\":\"stopped\",\"exitCode\":null}");
  assert.deepEqual(JSON.parse(String(requests[3]?.init?.body)), {
    status: "cancelled",
    stdout: "stopped",
    exitCode: null,
  });
});

test("reports bridge health as reachable or unreachable while preserving notification stats", async () => {
  const reachable = createOperations({
    requestJson: async (path) => {
      assert.equal(path, "jobs/stats");
      return {
        queuedCount: 0,
        runningCount: 0,
        activeCount: 0,
        terminalCount: 1,
        maxActiveJobs: 50,
        maxConcurrency: 2,
        oldestQueuedAgeMs: null,
      };
    },
  });
  assert.deepEqual(await reachable.operations.getDispatchHealth(), {
    bridge: {
      reachable: true,
      url: "http://127.0.0.1:3992",
      stats: {
        queuedCount: 0,
        runningCount: 0,
        activeCount: 0,
        terminalCount: 1,
        maxActiveJobs: 50,
        maxConcurrency: 2,
        oldestQueuedAgeMs: null,
      },
    },
    notifications: createStats(),
  });

  const unreachable = createOperations({
    requestJson: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.deepEqual(await unreachable.operations.getDispatchHealth(), {
    bridge: {
      reachable: false,
      url: "http://127.0.0.1:3992",
      error: "ECONNREFUSED",
    },
    notifications: createStats(),
  });
});

test("offline waits consume only their own persisted results without a GET", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-wait-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new NotificationStore<BridgeJob>({
    storePath: path.join(dir, "notifications.jsonl"), maxQueueSize: 10, lockStaleMs: 30_000,
    lockTimeoutMs: 5_000, previewMax: 2, previewTextMax: 128, normalizeNotification,
  });
  const a = createJob({ id: "job-a", status: "succeeded", stdout: "output A", exitCode: 0 });
  const b = createJob({ id: "job-b", status: "failed", stderr: "error B", exitCode: 1 });
  await store.enqueue(createNotification(b));
  await store.enqueue(createNotification(a));
  const { operations, requests } = createOperations({
    requestJson: async () => { throw new Error("bridge offline"); },
    drainNotificationForJob: (id) => store.drainForJob(id),
  });
  for (const job of [a, b]) {
    const result = await operations.waitForJobCompletion(job.id);
    assert.equal(result.jobId, job.id);
    assert.equal(result.job.id, job.id);
    assert.equal(result.status, job.status);
    assert.equal(result.job.stdout, job.stdout);
    assert.equal(result.job.stderr, job.stderr);
    assert.equal(result.job.exitCode, job.exitCode);
    assert.deepEqual(result.notification?.job, result.job);
    assert.equal(result.completed, true);
    assert.equal(result.timedOut, false);
    assert.equal(requests.length, 0);
  }
  assert.equal((await store.getStats()).pending, 0);
});

test("wait polls once on a miss and consumes a notification arriving before the next poll", async () => {
  const notification = createNotification(createJob({ status: "succeeded", stdout: "finished" }));
  let pending: JobNotification<BridgeJob> | null = null;
  const { operations, requests } = createOperations({
    requestJson: async () => createJob({ status: "running" }),
    drainNotificationForJob: async () => pending,
    sleep: async () => {
      assert.equal(requests.length, 1, "first poll must issue exactly one request");
      pending = notification;
    },
  });
  const result = await operations.waitForJobCompletion(notification.job.id);
  assert.deepEqual(result.notification, notification);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(requests.map(({ path, init }) => [path, init?.method]), [["jobs/job-1", "GET"]]);
});

test("wait propagates the original GET error after a notification miss", async () => {
  const offline = new Error("bridge offline");
  const drained: string[] = [];
  const { operations, requests, sleeps } = createOperations({
    requestJson: async () => { throw offline; },
    drainNotificationForJob: async (id) => { drained.push(id); return null; },
  });
  await assert.rejects(operations.waitForJobCompletion("job-1"), (error) => error === offline);
  assert.deepEqual(drained, ["job-1"]);
  assert.equal(requests.length, 1);
  assert.deepEqual(sleeps, []);
});

test("wait reports missing notification after terminal grace", async () => {
  let elapsed = 0;
  const { operations, requests } = createOperations({
    requestJson: async () => createJob({ id: "job-1", status: "succeeded", stdout: "done" }),
    now: () => elapsed,
    sleep: async (ms) => { elapsed += ms; },
  });

  const result = await operations.waitForJobCompletion("job-1", { waitTimeoutMs: 5_000, pollIntervalMs: 1_000 });

  assert.equal(result.status, "succeeded");
  assert.equal(result.completed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.notificationMissing, true);
  assert.equal(elapsed, 500);
  assert.equal(requests.length, 3); // At 0, 250 and 500 ms.
});

test("wait times out when the bridge job remains non-terminal", async () => {
  let elapsed = 0;
  const { operations, requests } = createOperations({
    requestJson: async () => createJob({ id: "job-1", status: "running" }),
    now: () => elapsed,
    sleep: async (ms) => { elapsed += ms; },
  });

  const result = await operations.waitForJobCompletion("job-1", { waitTimeoutMs: 1_000, pollIntervalMs: 500 });

  assert.equal(result.status, "running");
  assert.equal(result.completed, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.notification, null);
  assert.equal(elapsed, 1_000);
  assert.equal(requests.length, 3); // At 0, 500 and 1000 ms.
});
