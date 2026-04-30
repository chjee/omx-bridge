import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  buildCallbackSignatureHeader,
  extractWebhookJobId,
  normalizeNotification,
  normalizeWebhookJob,
  verifyWebhookSignature,
} from "./webhook-codec.js";

test("builds callback signatures with the canonical protocol", () => {
  const signature = buildCallbackSignatureHeader(
    "00000000-0000-4000-a000-000000000001",
    "{\"status\":\"succeeded\"}",
    "shared-secret",
  );

  assert.equal(
    signature,
    `sha256=${createHmac("sha256", "shared-secret")
      .update("00000000-0000-4000-a000-000000000001:{\"status\":\"succeeded\"}")
      .digest("hex")}`,
  );
});

test("verifies valid signatures and rejects malformed or mismatched signatures", () => {
  const body = "{\"status\":\"succeeded\"}";
  const signature = buildCallbackSignatureHeader("job-1", body, "secret");

  assert.equal(verifyWebhookSignature("job-1", body, signature, "secret"), true);
  assert.equal(verifyWebhookSignature("job-1", body, signature.slice("sha256=".length), "secret"), false);
  assert.equal(verifyWebhookSignature("job-1", body, "sha256=deadbeef", "secret"), false);
  assert.equal(verifyWebhookSignature("job-1", "{\"status\":\"failed\"}", signature, "secret"), false);
  assert.equal(verifyWebhookSignature("job-1", body, signature, "different-secret"), false);
});

test("skips signature verification when no secret is configured", () => {
  assert.equal(verifyWebhookSignature("job-1", "body", "not-a-signature", ""), true);
});

test("extracts canonical and legacy job identifiers", () => {
  assert.equal(extractWebhookJobId({ id: "job-1" }), "job-1");
  assert.equal(extractWebhookJobId({ jobId: "legacy-1" }), "legacy-1");
  assert.equal(extractWebhookJobId({ id: "", jobId: "legacy-2" }), "legacy-2");
  assert.equal(extractWebhookJobId({ id: 123 }), undefined);
});

test("normalizes webhook job payloads with optional fields", () => {
  const job = normalizeWebhookJob({
    id: "job-1",
    prompt: "build",
    cwd: "/workspace/project",
    queueOrder: "0001",
    requestId: "req-1",
    originRoutingKey: "telegram:direct:123",
    source: "channel",
    sourceName: "claude-chopper",
    notifyUrl: "http://127.0.0.1:3994/notify",
    metadata: { chat: 123 },
    status: "succeeded",
    createdAt: "2026-04-30T00:00:00.000Z",
    startedAt: "2026-04-30T00:00:01.000Z",
    finishedAt: "2026-04-30T00:00:02.000Z",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    execution: {
      command: "omx",
      timeoutMs: 1000,
      maxOutputChars: 2000,
      durationMs: 500,
      timedOut: false,
      outputTruncated: true,
      errorType: "non_zero_exit",
      recoveredFromRestart: true,
    },
  });

  assert.deepEqual(job, {
    id: "job-1",
    prompt: "build",
    cwd: "/workspace/project",
    queueOrder: "0001",
    requestId: "req-1",
    originRoutingKey: "telegram:direct:123",
    source: "channel",
    sourceName: "claude-chopper",
    notifyUrl: "http://127.0.0.1:3994/notify",
    metadata: { chat: 123 },
    status: "succeeded",
    createdAt: "2026-04-30T00:00:00.000Z",
    startedAt: "2026-04-30T00:00:01.000Z",
    finishedAt: "2026-04-30T00:00:02.000Z",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    execution: {
      command: "omx",
      timeoutMs: 1000,
      maxOutputChars: 2000,
      durationMs: 500,
      timedOut: false,
      outputTruncated: true,
      errorType: "non_zero_exit",
      recoveredFromRestart: true,
    },
  });
});

test("normalizes legacy jobId payloads and defaults missing optional data", () => {
  assert.deepEqual(normalizeWebhookJob({
    jobId: "legacy-1",
    status: "failed",
  }), {
    id: "legacy-1",
    prompt: "",
    cwd: undefined,
    queueOrder: "",
    requestId: undefined,
    originRoutingKey: undefined,
    source: undefined,
    sourceName: undefined,
    notifyUrl: undefined,
    metadata: undefined,
    status: "failed",
    createdAt: "",
    startedAt: undefined,
    finishedAt: undefined,
    exitCode: undefined,
    stdout: "",
    stderr: "",
    execution: {
      command: "",
      timeoutMs: 0,
      maxOutputChars: 0,
      durationMs: undefined,
      timedOut: undefined,
      outputTruncated: undefined,
      errorType: undefined,
      recoveredFromRestart: undefined,
    },
  });
});

test("rejects invalid webhook job payloads", () => {
  assert.equal(normalizeWebhookJob(null), null);
  assert.equal(normalizeWebhookJob({ id: "job-1" }), null);
  assert.equal(normalizeWebhookJob({ id: "job-1", status: "unknown" }), null);
  assert.equal(normalizeWebhookJob({ id: 1, status: "succeeded" }), null);
});

test("normalizes persisted notifications", () => {
  const notification = normalizeNotification({
    receivedAt: "2026-04-30T00:00:03.000Z",
    job: {
      id: "job-1",
      status: "cancelled",
      stdout: "stopped",
      stderr: "",
    },
  });

  assert.equal(notification?.receivedAt, "2026-04-30T00:00:03.000Z");
  assert.equal(notification?.job.id, "job-1");
  assert.equal(notification?.job.status, "cancelled");
});

test("rejects malformed persisted notifications", () => {
  assert.equal(normalizeNotification({ job: { id: "job-1", status: "succeeded" } }), null);
  assert.equal(normalizeNotification({ receivedAt: "2026-04-30T00:00:03.000Z", job: null }), null);
});
