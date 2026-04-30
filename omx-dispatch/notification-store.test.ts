import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NotificationStore,
  type JobNotification,
  type NotificationStoreJob,
} from "./notification-store.js";

type TestStatus = "queued" | "succeeded" | "failed";

interface TestJob extends NotificationStoreJob {
  status: TestStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNotification(payload: unknown): JobNotification<TestJob> | null {
  if (!isRecord(payload) || typeof payload["receivedAt"] !== "string") {
    return null;
  }
  const job = payload["job"];
  if (
    !isRecord(job) ||
    typeof job["id"] !== "string" ||
    (job["status"] !== "queued" && job["status"] !== "succeeded" && job["status"] !== "failed") ||
    typeof job["stdout"] !== "string" ||
    typeof job["stderr"] !== "string"
  ) {
    return null;
  }

  return {
    receivedAt: payload["receivedAt"],
    job: {
      id: job["id"],
      status: job["status"],
      finishedAt: typeof job["finishedAt"] === "string" ? job["finishedAt"] : undefined,
      stdout: job["stdout"],
      stderr: job["stderr"],
    },
  };
}

function createNotification(
  id: string,
  receivedAt: string,
  overrides: Partial<TestJob> = {},
): JobNotification<TestJob> {
  return {
    receivedAt,
    job: {
      id,
      status: overrides.status ?? "succeeded",
      finishedAt: overrides.finishedAt,
      stdout: overrides.stdout ?? `stdout:${id}`,
      stderr: overrides.stderr ?? `stderr:${id}`,
    },
  };
}

async function createStore(maxQueueSize = 10): Promise<{
  store: NotificationStore<TestJob>;
  storePath: string;
  warnings: string[];
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omx-dispatch-store-"));
  const storePath = path.join(dir, "notifications.jsonl");
  const warnings: string[] = [];
  const store = new NotificationStore<TestJob>({
    storePath,
    maxQueueSize,
    lockStaleMs: 30_000,
    lockTimeoutMs: 5_000,
    previewMax: 20,
    previewTextMax: 8,
    normalizeNotification,
    logWarning: (message) => warnings.push(message),
  });
  return { store, storePath, warnings };
}

test("dedupes notifications by job id and keeps the newest entry", async () => {
  const { store } = await createStore();

  await store.enqueue(createNotification("job-1", "2026-04-30T00:00:00.000Z", { stdout: "old" }));
  await store.enqueue(createNotification("job-2", "2026-04-30T00:00:01.000Z"));
  await store.enqueue(createNotification("job-1", "2026-04-30T00:00:02.000Z", { stdout: "new" }));

  const drained = await store.drainAll();

  assert.deepEqual(drained.map((item) => item.job.id), ["job-2", "job-1"]);
  assert.equal(drained[1]?.job.stdout, "new");
});

test("enforces queue overflow retention", async () => {
  const { store } = await createStore(2);

  await store.enqueue(createNotification("job-1", "2026-04-30T00:00:00.000Z"));
  await store.enqueue(createNotification("job-2", "2026-04-30T00:00:01.000Z"));
  await store.enqueue(createNotification("job-3", "2026-04-30T00:00:02.000Z"));

  const stats = await store.getStats();
  const drained = await store.drainAll();

  assert.equal(stats.pending, 2);
  assert.equal(stats.dropped, 1);
  assert.deepEqual(drained.map((item) => item.job.id), ["job-2", "job-3"]);
});

test("loads persisted notifications while compacting malformed and overflow entries", async () => {
  const { store, storePath, warnings } = await createStore(2);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    [
      JSON.stringify(createNotification("job-1", "2026-04-30T00:00:00.000Z")),
      "{not-json",
      JSON.stringify({ receivedAt: "2026-04-30T00:00:01.000Z", job: { id: "bad" } }),
      JSON.stringify(createNotification("job-2", "2026-04-30T00:00:02.000Z")),
      JSON.stringify(createNotification("job-3", "2026-04-30T00:00:03.000Z")),
      "",
    ].join("\n"),
    "utf8",
  );

  await store.load();

  const stats = await store.getStats();
  const rewritten = await fs.readFile(storePath, "utf8");

  assert.equal(stats.pending, 2);
  assert.equal(stats.dropped, 1);
  assert.match(warnings.join("\n"), /skipped 2 malformed/);
  assert.deepEqual(
    rewritten.trim().split(/\r?\n/).map((line) => normalizeNotification(JSON.parse(line))?.job.id),
    ["job-2", "job-3"],
  );
});

test("drains a single job while preserving remaining notifications", async () => {
  const { store } = await createStore();
  await store.enqueue(createNotification("job-1", "2026-04-30T00:00:00.000Z"));
  await store.enqueue(createNotification("job-2", "2026-04-30T00:00:01.000Z"));

  const drainedJob = await store.drainForJob("job-1");
  const remaining = await store.drainAll();

  assert.equal(drainedJob?.job.id, "job-1");
  assert.deepEqual(remaining.map((item) => item.job.id), ["job-2"]);
});

test("builds bounded notification previews", async () => {
  const { store } = await createStore();
  await store.enqueue(createNotification("job-1", "2026-04-30T00:00:00.000Z", {
    finishedAt: "2026-04-30T00:00:01.000Z",
    stdout: "1234567890",
    stderr: "abcdefghij",
  }));

  const stats = await store.getStats(1);

  assert.equal(stats.preview?.[0]?.jobId, "job-1");
  assert.equal(stats.preview?.[0]?.stdoutPreview, "12345678");
  assert.equal(stats.preview?.[0]?.stderrPreview, "abcdefgh");
  assert.equal(stats.preview?.[0]?.finishedAt, "2026-04-30T00:00:01.000Z");
});
