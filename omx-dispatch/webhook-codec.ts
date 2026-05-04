import { createHmac, timingSafeEqual } from "node:crypto";
import type { JobNotification } from "./notification-store.js";
import {
  JOB_STATUS_VALUES,
  type BridgeJob,
  type BridgeJobExecution,
  type JobSource,
  type JobStatus,
} from "./tool-handlers.js";

// ---------------------------------------------------------------------------
// Callback signature protocol — MIRRORS src/jobs/callback-signature.ts.
//
// All three implementations must stay byte-for-byte equivalent:
//   - src/jobs/callback-signature.ts        (server, source of truth)
//   - omx-dispatch/webhook-codec.ts         (MCP dispatch callback receiver)
//   - omx-bridge-plugin/index.ts
//
// Protocol contract:
//   header  = X-Callback-Signature
//   value   = "sha256=" + hex(HMAC_SHA256(secret, jobId + ":" + body))
//
// If you change anything here, update the other two and the vectors in
// test/unit/callback-signature.spec.ts in the same change.
// ---------------------------------------------------------------------------
export function buildCallbackSignatureHeader(jobId: string, body: string, secret: string): string {
  const message = `${jobId}:${body}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `sha256=${hex}`;
}

export function verifyWebhookSignature(
  jobId: string,
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret) return true;
  if (!signature.startsWith("sha256=")) return false;
  const expected = buildCallbackSignatureHeader(jobId, rawBody, secret);
  try {
    return timingSafeEqual(
      Buffer.from(expected.slice("sha256=".length), "hex"),
      Buffer.from(signature.slice("sha256=".length), "hex"),
    );
  } catch {
    return false;
  }
}

export function extractWebhookJobId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return getStringField(payload, "id") ?? getStringField(payload, "jobId");
}

export function normalizeWebhookJob(payload: unknown): BridgeJob | null {
  if (!isRecord(payload)) return null;

  const id = extractWebhookJobId(payload);
  if (!id || !isJobStatus(payload["status"])) {
    return null;
  }

  const execution = isRecord(payload["execution"]) ? payload["execution"] : {};
  const rawSource = payload["source"];

  return {
    id,
    prompt: getStringField(payload, "prompt") ?? "",
    cwd: getStringField(payload, "cwd"),
    queueOrder: getStringField(payload, "queueOrder") ?? "",
    requestId: getStringField(payload, "requestId"),
    originRoutingKey: getStringField(payload, "originRoutingKey"),
    source: isJobSource(rawSource) ? rawSource : undefined,
    sourceName: getStringField(payload, "sourceName"),
    notifyUrl: getStringField(payload, "notifyUrl"),
    metadata: isRecord(payload["metadata"]) ? payload["metadata"] : undefined,
    status: payload["status"],
    createdAt: getStringField(payload, "createdAt") ?? "",
    startedAt: getStringField(payload, "startedAt"),
    finishedAt: getStringField(payload, "finishedAt"),
    exitCode: typeof payload["exitCode"] === "number" || payload["exitCode"] === null
      ? payload["exitCode"]
      : undefined,
    stdout: getStringField(payload, "stdout") ?? "",
    stderr: getStringField(payload, "stderr") ?? "",
    execution: {
      command: getStringField(execution, "command") ?? "",
      timeoutMs: typeof execution["timeoutMs"] === "number" ? execution["timeoutMs"] : 0,
      maxOutputChars: typeof execution["maxOutputChars"] === "number" ? execution["maxOutputChars"] : 0,
      durationMs: typeof execution["durationMs"] === "number" ? execution["durationMs"] : undefined,
      timedOut: typeof execution["timedOut"] === "boolean" ? execution["timedOut"] : undefined,
      outputTruncated: typeof execution["outputTruncated"] === "boolean"
        ? execution["outputTruncated"]
        : undefined,
      errorType: typeof execution["errorType"] === "string"
        && ["spawn_error", "timeout", "non_zero_exit", "cancelled", "execution_error", "invalid_cwd"].includes(execution["errorType"])
        ? execution["errorType"] as BridgeJobExecution["errorType"]
        : undefined,
      recoveredFromRestart: typeof execution["recoveredFromRestart"] === "boolean"
        ? execution["recoveredFromRestart"]
        : undefined,
    },
  };
}

export function normalizeNotification(payload: unknown): JobNotification<BridgeJob> | null {
  if (!isRecord(payload)) return null;
  const receivedAt = getStringField(payload, "receivedAt");
  const job = normalizeWebhookJob(payload["job"]);
  if (!receivedAt || !job) {
    return null;
  }

  return { receivedAt, job };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && JOB_STATUS_VALUES.includes(value as JobStatus);
}

function isJobSource(value: unknown): value is JobSource {
  return value === "dispatch" || value === "channel" || value === "synapse" || value === "openclaw";
}
