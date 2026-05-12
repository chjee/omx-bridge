import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  handleWebhookRequest,
  type WebhookJob,
  type WebhookServerOptions,
} from "./webhook-server.js";
import type { JobNotification } from "./notification-store.js";

interface TestJob extends WebhookJob {
  status: "succeeded" | "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJobId(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload["id"] === "string" ? payload["id"] : undefined;
}

function normalizeJob(payload: unknown): TestJob | null {
  if (
    !isRecord(payload) ||
    typeof payload["id"] !== "string" ||
    (payload["status"] !== "succeeded" && payload["status"] !== "failed")
  ) {
    return null;
  }
  return {
    id: payload["id"],
    status: payload["status"],
    stdout: typeof payload["stdout"] === "string" ? payload["stdout"] : "",
    stderr: typeof payload["stderr"] === "string" ? payload["stderr"] : "",
    finishedAt: typeof payload["finishedAt"] === "string" ? payload["finishedAt"] : undefined,
  };
}

function createTestOptions(
  overrides: Partial<WebhookServerOptions<TestJob>> = {},
): {
  options: WebhookServerOptions<TestJob>;
  enqueued: Array<JobNotification<TestJob>>;
  logged: string[];
  channeled: string[];
} {
  const enqueued: Array<JobNotification<TestJob>> = [];
  const logged: string[] = [];
  const channeled: string[] = [];
  const options: WebhookServerOptions<TestJob> = {
    bodyLimitBytes: 1_000_000,
    signatureRequired: false,
    extractJobId,
    verifySignature: (jobId, rawBody, signature) => signature === `sig:${jobId}:${rawBody}`,
    normalizeJob,
    enqueueNotification: async (notification) => {
      enqueued.push(notification);
      return enqueued.length;
    },
    sendLoggingMessage: async (job) => {
      logged.push(job.id);
    },
    sendChannelNotification: async (job) => {
      channeled.push(job.id);
    },
    getNotificationStats: async () => ({
      pending: enqueued.length,
      dropped: 2,
      storePath: "/tmp/notifications.jsonl",
      storeBytes: 123,
    }),
    ...overrides,
  };

  return {
    options,
    enqueued,
    logged,
    channeled,
  };
}

interface MockResponse {
  status: number;
  headers: Record<string, string | number | readonly string[]>;
  body: string;
  response: ServerResponse;
}

function createMockRequest(
  method: string,
  url: string,
  body = "",
  headers: Record<string, string> = {},
): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]);
  Object.assign(request, {
    method,
    url,
    headers: Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    ),
  });
  return request as unknown as IncomingMessage;
}

function createMockResponse(): MockResponse {
  const mock: MockResponse = {
    status: 0,
    headers: {},
    body: "",
    response: {} as ServerResponse,
  };
  mock.response = {
    writeHead(status: number, headers: Record<string, string | number | readonly string[]>) {
      mock.status = status;
      mock.headers = headers;
      return this;
    },
    end(payload?: string | Buffer) {
      mock.body = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload ?? "";
      return this;
    },
  } as ServerResponse;
  return mock;
}

async function request(
  options: WebhookServerOptions<TestJob>,
  method: string,
  url: string,
  body = "",
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: MockResponse["headers"] }> {
  const response = createMockResponse();
  await handleWebhookRequest(
    createMockRequest(method, url, body, headers),
    response.response,
    options,
  );

  return {
    status: response.status,
    body: JSON.parse(response.body),
    headers: response.headers,
  };
}

async function postNotify(
  options: WebhookServerOptions<TestJob>,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: MockResponse["headers"] }> {
  return request(options, "POST", "/notify", body, {
    "Content-Type": "application/json",
    ...headers,
  });
}

test("rejects invalid JSON bodies", async () => {
  const server = createTestOptions();
  const response = await postNotify(server.options, "{not-json");

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Invalid JSON body" });
});

test("rejects notify payloads without a job id", async () => {
  const server = createTestOptions();
  const response = await postNotify(server.options, JSON.stringify({ status: "succeeded" }));

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Missing job id" });
});

test("requires callback signatures when configured", async () => {
  const server = createTestOptions({ signatureRequired: true });
  const response = await postNotify(server.options, JSON.stringify({ id: "job-1", status: "succeeded" }));

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "Missing X-Callback-Signature header" });
});

test("rejects invalid callback signatures", async () => {
  const server = createTestOptions({ signatureRequired: true });
  const body = JSON.stringify({ id: "job-1", status: "succeeded" });
  const response = await postNotify(server.options, body, { "X-Callback-Signature": "sig:wrong" });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "Signature verification failed" });
});

test("rejects oversized notify bodies", async () => {
  const server = createTestOptions({ bodyLimitBytes: 20 });
  const response = await postNotify(server.options, JSON.stringify({
    id: "job-1",
    status: "succeeded",
    stdout: "x".repeat(100),
  }));

  assert.equal(response.status, 413);
  assert.deepEqual(response.body, { error: "Request body too large" });
});

test("enqueues valid notify payloads and sends side-channel notifications", async () => {
  const server = createTestOptions({ signatureRequired: true });
  const body = JSON.stringify({ id: "job-1", status: "succeeded", stdout: "ok", stderr: "" });
  const response = await postNotify(server.options, body, {
    "X-Callback-Signature": `sig:job-1:${body}`,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, queued: 1 });
  assert.equal(server.enqueued[0]?.job.id, "job-1");
  assert.deepEqual(server.logged, ["job-1"]);
  assert.deepEqual(server.channeled, ["job-1"]);
});

test("returns notification stats from health endpoint", async () => {
  const server = createTestOptions();
  const response = await request(server.options, "GET", "/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    pending: 0,
    dropped: 2,
    storePath: "/tmp/notifications.jsonl",
    storeBytes: 123,
  });
});
