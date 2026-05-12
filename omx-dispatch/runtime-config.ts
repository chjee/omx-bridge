import path from "node:path";

export interface DispatchRuntimeConfig {
  serverVersion: string;
  bridgeUrl: string;
  bridgeCallbackSecret: string;
  bridgeApiToken: string;
  insecureLoopback: boolean;
  bridgeRequestTimeoutMs: number;
  webhookPort: number;
  webhookPortMin: number;
  webhookPortMax: number;
  webhookBodyLimitBytes: number;
  enableClaudeChannel: boolean;
  maxNotificationQueueSize: number;
  notificationStorePath: string;
  notificationLockStaleMs: number;
  notificationLockTimeoutMs: number;
  notificationPreviewMax: number;
  notificationPreviewTextMax: number;
  defaultWaitTimeoutMs: number;
  defaultWaitPollIntervalMs: number;
  maxWaitTimeoutMs: number;
  minWaitPollIntervalMs: number;
  maxWaitPollIntervalMs: number;
  terminalNotificationGraceMs: number;
}

export const DEFAULT_BRIDGE_URL = "http://localhost:3992";
export const DEFAULT_SERVER_VERSION = "0.1.0";
export const DEFAULT_WEBHOOK_PORT_MIN = 12000;
export const DEFAULT_WEBHOOK_PORT_MAX = 12999;
export const DEFAULT_WEBHOOK_BODY_LIMIT_BYTES = 1_000_000;
export const DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE = 200;
export const DEFAULT_NOTIFICATION_LOCK_STALE_MS = 30_000;
export const DEFAULT_NOTIFICATION_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_NOTIFICATION_PREVIEW_MAX = 20;
export const DEFAULT_NOTIFICATION_PREVIEW_TEXT_MAX = 200;
export const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_MAX_WAIT_TIMEOUT_MS = 3_600_000;
export const DEFAULT_MIN_WAIT_POLL_INTERVAL_MS = 250;
export const DEFAULT_MAX_WAIT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_TERMINAL_NOTIFICATION_GRACE_MS = 2_000;

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): DispatchRuntimeConfig {
  const bridgeUrl = env["BRIDGE_URL"] ?? DEFAULT_BRIDGE_URL;
  const insecureLoopback = parseBoolean(
    env["OMX_DISPATCH_INSECURE_LOOPBACK"] ?? env["BRIDGE_INSECURE_LOOPBACK"],
  );
  const bridgeCallbackSecret = env["BRIDGE_CALLBACK_SECRET"] ?? "";
  const bridgeApiToken = env["BRIDGE_API_TOKEN"] ?? "";

  if (insecureLoopback && !isLoopbackBridgeUrl(bridgeUrl)) {
    throw new Error("OMX_DISPATCH_INSECURE_LOOPBACK is only allowed for loopback BRIDGE_URL");
  }
  if (!insecureLoopback && !bridgeApiToken) {
    throw new Error("BRIDGE_API_TOKEN is required unless OMX_DISPATCH_INSECURE_LOOPBACK=1");
  }
  if (!insecureLoopback && !bridgeCallbackSecret) {
    throw new Error("BRIDGE_CALLBACK_SECRET is required unless OMX_DISPATCH_INSECURE_LOOPBACK=1");
  }

  return {
    serverVersion: DEFAULT_SERVER_VERSION,
    bridgeUrl,
    bridgeCallbackSecret,
    bridgeApiToken,
    insecureLoopback,
    bridgeRequestTimeoutMs: parsePositiveInt(
      env["BRIDGE_REQUEST_TIMEOUT_MS"],
      10_000,
    ),
    webhookPort: Number.parseInt(env["WEBHOOK_PORT"] ?? "0", 10),
    webhookPortMin: DEFAULT_WEBHOOK_PORT_MIN,
    webhookPortMax: DEFAULT_WEBHOOK_PORT_MAX,
    webhookBodyLimitBytes: parsePositiveInt(
      env["OMX_DISPATCH_WEBHOOK_BODY_LIMIT_BYTES"],
      DEFAULT_WEBHOOK_BODY_LIMIT_BYTES,
    ),
    enableClaudeChannel: parseBoolean(env["ENABLE_CLAUDE_CHANNEL"]),
    maxNotificationQueueSize: parsePositiveInt(
      env["MAX_NOTIFICATION_QUEUE_SIZE"],
      DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE,
    ),
    notificationStorePath: env["OMX_DISPATCH_NOTIFICATION_STORE_PATH"]
      ?? path.join(cwd, ".omx", "state", "omx-dispatch-notifications.jsonl"),
    notificationLockStaleMs: DEFAULT_NOTIFICATION_LOCK_STALE_MS,
    notificationLockTimeoutMs: DEFAULT_NOTIFICATION_LOCK_TIMEOUT_MS,
    notificationPreviewMax: DEFAULT_NOTIFICATION_PREVIEW_MAX,
    notificationPreviewTextMax: DEFAULT_NOTIFICATION_PREVIEW_TEXT_MAX,
    defaultWaitTimeoutMs: parsePositiveInt(
      env["OMX_DISPATCH_WAIT_TIMEOUT_MS"],
      DEFAULT_WAIT_TIMEOUT_MS,
    ),
    defaultWaitPollIntervalMs: parsePositiveInt(
      env["OMX_DISPATCH_WAIT_POLL_INTERVAL_MS"],
      DEFAULT_WAIT_POLL_INTERVAL_MS,
    ),
    maxWaitTimeoutMs: DEFAULT_MAX_WAIT_TIMEOUT_MS,
    minWaitPollIntervalMs: DEFAULT_MIN_WAIT_POLL_INTERVAL_MS,
    maxWaitPollIntervalMs: DEFAULT_MAX_WAIT_POLL_INTERVAL_MS,
    terminalNotificationGraceMs: DEFAULT_TERMINAL_NOTIFICATION_GRACE_MS,
  };
}

export function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function isLoopbackBridgeUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
