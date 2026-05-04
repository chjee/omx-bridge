import { createHmac, timingSafeEqual } from "node:crypto";
import type { JobNotification } from "./notification-store.js";
import {
  BRIDGE_EXECUTION_ERROR_TYPES,
  JOB_EXECUTION_MODE_VALUES,
  JOB_SOURCE_VALUES,
  JOB_STATUS_VALUES,
  NOTIFY_CHANNEL_STATUS_VALUES,
  NOTIFY_MODE_VALUES,
  NOTIFY_TRIGGER_VALUES,
  TMUX_SESSION_STATUS_VALUES,
  type BridgeJob,
  type BridgeExecutionErrorType,
  type JobExecutionMode,
  type JobSource,
  type JobStatus,
  type NotifyChannelResult,
  type NotifyMode,
  type NotifyOutcome,
  type NotifyTrigger,
  type TmuxSessionState,
  type TmuxSessionStatus,
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
  const session = normalizeTmuxSession(payload["session"]);
  const notifyOutcome = normalizeNotifyOutcome(payload["notifyOutcome"]);
  const notifyHistory = Array.isArray(payload["notifyHistory"])
    ? payload["notifyHistory"]
      .map((entry) => normalizeNotifyOutcome(entry))
      .filter((entry): entry is NotifyOutcome => entry !== undefined)
    : undefined;

  return {
    id,
    prompt: getStringField(payload, "prompt") ?? "",
    ...(isJobExecutionMode(payload["executionMode"]) ? { executionMode: payload["executionMode"] } : {}),
    cwd: getStringField(payload, "cwd"),
    queueOrder: getStringField(payload, "queueOrder") ?? "",
    requestId: getStringField(payload, "requestId"),
    ...(getStringField(payload, "requestFingerprint")
      ? { requestFingerprint: getStringField(payload, "requestFingerprint") }
      : {}),
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
        && BRIDGE_EXECUTION_ERROR_TYPES.includes(execution["errorType"] as BridgeExecutionErrorType)
        ? execution["errorType"] as BridgeExecutionErrorType
        : undefined,
      recoveredFromRestart: typeof execution["recoveredFromRestart"] === "boolean"
        ? execution["recoveredFromRestart"]
        : undefined,
    },
    ...(session ? { session } : {}),
    ...(notifyOutcome ? { notifyOutcome } : {}),
    ...(notifyHistory ? { notifyHistory } : {}),
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

function isJobExecutionMode(value: unknown): value is JobExecutionMode {
  return typeof value === "string" && JOB_EXECUTION_MODE_VALUES.includes(value as JobExecutionMode);
}

function isJobSource(value: unknown): value is JobSource {
  return typeof value === "string" && JOB_SOURCE_VALUES.includes(value as JobSource);
}

function normalizeTmuxSession(payload: unknown): TmuxSessionState | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload["backend"] !== "tmux" || !isTmuxSessionStatus(payload["status"])) {
    return undefined;
  }
  const sessionName = getStringField(payload, "sessionName");
  const createdAt = getStringField(payload, "createdAt");
  const updatedAt = getStringField(payload, "updatedAt");
  const attachCommand = getStringField(payload, "attachCommand");
  if (!sessionName || !createdAt || !updatedAt || !attachCommand) {
    return undefined;
  }

  return {
    backend: "tmux",
    sessionName,
    status: payload["status"],
    createdAt,
    updatedAt,
    attachCommand,
    cwd: getStringField(payload, "cwd"),
    lastExitCode: typeof payload["lastExitCode"] === "number" || payload["lastExitCode"] === null
      ? payload["lastExitCode"]
      : undefined,
  };
}

function isTmuxSessionStatus(value: unknown): value is TmuxSessionStatus {
  return typeof value === "string" && TMUX_SESSION_STATUS_VALUES.includes(value as TmuxSessionStatus);
}

function normalizeNotifyOutcome(payload: unknown): NotifyOutcome | undefined {
  if (!isRecord(payload)) return undefined;
  const attemptedAt = getStringField(payload, "attemptedAt");
  if (!attemptedAt || !isNotifyMode(payload["mode"])) {
    return undefined;
  }

  return {
    attemptedAt,
    mode: payload["mode"],
    trigger: isNotifyTrigger(payload["trigger"]) ? payload["trigger"] : undefined,
    attemptIndex: typeof payload["attemptIndex"] === "number" ? payload["attemptIndex"] : undefined,
    claudeWebhook: normalizeNotifyChannelResult(payload["claudeWebhook"]),
    openclaw: normalizeNotifyChannelResult(payload["openclaw"]),
    telegram: normalizeNotifyChannelResult(payload["telegram"]),
  };
}

function isNotifyMode(value: unknown): value is NotifyMode {
  return typeof value === "string" && NOTIFY_MODE_VALUES.includes(value as NotifyMode);
}

function isNotifyTrigger(value: unknown): value is NotifyTrigger {
  return typeof value === "string" && NOTIFY_TRIGGER_VALUES.includes(value as NotifyTrigger);
}

function normalizeNotifyChannelResult(payload: unknown): NotifyChannelResult | undefined {
  if (!isRecord(payload) || !isNotifyChannelStatus(payload["status"])) {
    return undefined;
  }

  return {
    status: payload["status"],
    error: getStringField(payload, "error"),
    httpStatus: typeof payload["httpStatus"] === "number" ? payload["httpStatus"] : undefined,
    attempts: typeof payload["attempts"] === "number" ? payload["attempts"] : undefined,
    skippedReason: getStringField(payload, "skippedReason"),
  };
}

function isNotifyChannelStatus(value: unknown): value is NotifyChannelResult["status"] {
  return typeof value === "string" && NOTIFY_CHANNEL_STATUS_VALUES.includes(value as NotifyChannelResult["status"]);
}
