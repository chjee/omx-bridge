import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { JobNotification } from "./notification-store.js";

export interface WebhookJob {
  id: string;
  status: string;
  finishedAt?: string;
  stdout: string;
  stderr: string;
}

export interface WebhookNotificationStats {
  pending: number;
  dropped: number;
  storePath: string;
  storeBytes: number;
}

export interface WebhookServerOptions<TJob extends WebhookJob> {
  bodyLimitBytes: number;
  signatureRequired: boolean;
  extractJobId: (payload: unknown) => string | undefined;
  verifySignature: (jobId: string, rawBody: string, signature: string) => boolean;
  normalizeJob: (payload: unknown) => TJob | null;
  enqueueNotification: (notification: JobNotification<TJob>) => Promise<number>;
  sendLoggingMessage: (job: TJob) => Promise<void>;
  sendChannelNotification: (job: TJob) => Promise<void>;
  getNotificationStats: () => Promise<WebhookNotificationStats>;
  describeError?: (error: unknown) => string;
}

export interface StartWebhookServerOptions<TJob extends WebhookJob> extends WebhookServerOptions<TJob> {
  port: number;
  portMin: number;
  portMax: number;
  onListening?: (notifyUrl: string) => void;
  onLog?: (message: string) => void;
}

export interface StartedWebhookServer {
  server: Server;
  notifyUrl: string;
}

class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Request body exceeds ${limitBytes} bytes`);
  }
}

export function createWebhookServer<TJob extends WebhookJob>(
  options: WebhookServerOptions<TJob>,
): Server {
  return createServer((req, res) => {
    void handleWebhookRequest(req, res, options);
  });
}

export async function handleWebhookRequest<TJob extends WebhookJob>(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebhookServerOptions<TJob>,
): Promise<void> {
  if (req.method === "POST" && req.url === "/notify") {
    await handleNotify(req, res, options);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    await handleHealth(res, options);
    return;
  }

  sendJsonResponse(res, 404, { error: "Not found" });
}

export function startWebhookServer<TJob extends WebhookJob>(
  options: StartWebhookServerOptions<TJob>,
): Promise<StartedWebhookServer> {
  return new Promise((resolve, reject) => {
    const http = createWebhookServer(options);
    let currentPort = options.port > 0
      ? options.port
      : options.portMin + Math.floor(Math.random() * (options.portMax - options.portMin + 1));

    const tryListen = () => http.listen(currentPort, "127.0.0.1");

    http.on("listening", () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : currentPort;
      const notifyUrl = `http://127.0.0.1:${port}/notify`;
      options.onListening?.(notifyUrl);
      options.onLog?.(`Webhook server listening on ${notifyUrl}`);
      resolve({ server: http, notifyUrl });
    });

    http.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && options.port === 0 && currentPort < options.portMax) {
        currentPort++;
        tryListen();
      } else {
        options.onLog?.(`Webhook server error: ${err.message}`);
        reject(err);
      }
    });

    tryListen();
  });
}

async function handleNotify<TJob extends WebhookJob>(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebhookServerOptions<TJob>,
): Promise<void> {
  let rawBody: string;
  try {
    rawBody = await readBody(req, options.bodyLimitBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJsonResponse(res, 413, { error: "Request body too large" });
      return;
    }
    sendJsonResponse(res, 400, { error: "Failed to read request body" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    sendJsonResponse(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const jobId = options.extractJobId(payload);
  if (!jobId) {
    sendJsonResponse(res, 400, { error: "Missing job id" });
    return;
  }

  const signature = req.headers["x-callback-signature"] as string | undefined;
  if (options.signatureRequired && !signature) {
    sendJsonResponse(res, 401, { error: "Missing X-Callback-Signature header" });
    return;
  }
  if (signature && !options.verifySignature(jobId, rawBody, signature)) {
    sendJsonResponse(res, 401, { error: "Signature verification failed" });
    return;
  }

  const job = options.normalizeJob(payload);
  if (!job) {
    sendJsonResponse(res, 400, { error: "Invalid job notification payload" });
    return;
  }

  const notification: JobNotification<TJob> = {
    receivedAt: new Date().toISOString(),
    job,
  };
  let queued: number;
  try {
    queued = await options.enqueueNotification(notification);
  } catch (error) {
    sendJsonResponse(res, 503, {
      error: "Failed to persist job notification",
      details: describeError(error, options),
    });
    return;
  }

  try {
    await options.sendLoggingMessage(job);
  } catch {
    // MCP connection may already be gone; queueing and webhook response still succeed.
  }

  try {
    await options.sendChannelNotification(job);
  } catch {
    // Channel preview is optional; queueing and logging paths remain authoritative.
  }

  sendJsonResponse(res, 200, { ok: true, queued });
}

async function handleHealth<TJob extends WebhookJob>(
  res: ServerResponse,
  options: WebhookServerOptions<TJob>,
): Promise<void> {
  let stats: WebhookNotificationStats;
  try {
    stats = await options.getNotificationStats();
  } catch (error) {
    sendJsonResponse(res, 503, {
      ok: false,
      error: "Failed to read notification stats",
      details: describeError(error, options),
    });
    return;
  }
  sendJsonResponse(res, 200, {
    ok: true,
    pending: stats.pending,
    dropped: stats.dropped,
    storePath: stats.storePath,
    storeBytes: stats.storeBytes,
  });
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        fail(new BodyTooLargeError(limitBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: Error) => fail(error);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function sendJsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function describeError<TJob extends WebhookJob>(
  error: unknown,
  options: WebhookServerOptions<TJob>,
): string {
  return options.describeError
    ? options.describeError(error)
    : error instanceof Error ? error.message : String(error);
}
