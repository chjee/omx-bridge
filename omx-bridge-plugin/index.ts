import { createHmac } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "omx-bridge-plugin";
const DEFAULT_BRIDGE_URL = "http://localhost:3992";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const JOB_STATUS_VALUES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
const JOB_SOURCE_VALUES = ["dispatch", "channel", "synapse", "openclaw"] as const;

const pluginConfigSchema = Type.Object(
  {
    bridgeUrl: Type.Optional(
      Type.String({
        default: DEFAULT_BRIDGE_URL,
        description: "Base URL for the omx-bridge HTTP service.",
      }),
    ),
    callbackSecret: Type.Optional(
      Type.String({
        description: "HMAC-SHA256 secret for signing callback requests. Must match BRIDGE_CALLBACK_SECRET on the server.",
      }),
    ),
    apiToken: Type.Optional(
      Type.String({
        description: "Bearer token for non-callback bridge routes (POST /jobs etc.). Must match BRIDGE_API_TOKEN on the server when set.",
      }),
    ),
    requestTimeoutMs: Type.Optional(
      Type.Number({
        minimum: 1,
        default: DEFAULT_REQUEST_TIMEOUT_MS,
        description: "Timeout in milliseconds for each omx-bridge HTTP request.",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

const openClawConfigSchema: OpenClawPluginConfigSchema = {
  jsonSchema: pluginConfigSchema as OpenClawPluginConfigSchema["jsonSchema"],
};

const submitJobParameters = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      maxLength: 4000,
      description: "Prompt to submit to the omx-bridge service.",
    }),
    cwd: Type.Optional(
      Type.String({
        maxLength: 500,
        description: "Working directory for the job. Must be an absolute path when provided.",
      }),
    ),
    requestId: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "Optional request correlation identifier.",
      }),
    ),
    originRoutingKey: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "Routing key of the conversation that initiated this job.",
      }),
    ),
    notifyUrl: Type.Optional(
      Type.String({
        maxLength: 500,
        description: "Loopback webhook URL to receive job completion callbacks.",
      }),
    ),
    sourceName: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "Optional concrete OpenClaw integration name for routing diagnostics.",
      }),
    ),
    metadata: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Unknown({
          description: "Additional OpenClaw metadata passed through to the bridge.",
        }),
      ),
    ),
  },
  {
    additionalProperties: false,
  },
);

const jobIdParameters = Type.Object(
  {
    jobId: Type.String({
      minLength: 1,
      description: "Bridge job identifier.",
    }),
  },
  {
    additionalProperties: false,
  },
);

const listJobsParameters = Type.Object(
  {
    status: Type.Optional(
      Type.Union(
        JOB_STATUS_VALUES.map((status) => Type.Literal(status)),
        { description: "Optional status filter." },
      ),
    ),
  },
  {
    additionalProperties: false,
  },
);

type PluginConfig = Static<typeof pluginConfigSchema>;
type SubmitJobParameters = Static<typeof submitJobParameters>;
type JobIdParameters = Static<typeof jobIdParameters>;
type ListJobsParameters = Static<typeof listJobsParameters>;

interface BridgeJobExecution {
  command: string;
  timeoutMs: number;
  maxOutputChars: number;
  durationMs?: number;
  timedOut?: boolean;
  outputTruncated?: boolean;
  errorType?: "spawn_error" | "timeout" | "non_zero_exit" | "cancelled" | "execution_error" | "invalid_cwd";
  recoveredFromRestart?: boolean;
}

interface BridgeJob {
  id: string;
  prompt: string;
  cwd?: string;
  originRoutingKey?: string;
  source?: (typeof JOB_SOURCE_VALUES)[number];
  sourceName?: string;
  notifyUrl?: string;
  queueOrder: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  status: (typeof JOB_STATUS_VALUES)[number];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  execution: BridgeJobExecution;
}

interface CreateJobResponse {
  jobId: string;
  status: BridgeJob["status"];
}

function getPluginConfig(api: OpenClawPluginApi): PluginConfig {
  const loadedConfig = api.runtime.config.loadConfig() as {
    plugins?: {
      entries?: Record<string, { config?: PluginConfig }>;
    };
  };
  const pluginConfig = loadedConfig.plugins?.entries?.[PLUGIN_ID]?.config;
  if (!pluginConfig || typeof pluginConfig !== "object") {
    return { bridgeUrl: DEFAULT_BRIDGE_URL };
  }

  const requestTimeoutMs =
    typeof pluginConfig.requestTimeoutMs === "number" &&
    Number.isFinite(pluginConfig.requestTimeoutMs) &&
    pluginConfig.requestTimeoutMs > 0
      ? Math.floor(pluginConfig.requestTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    bridgeUrl:
      typeof pluginConfig.bridgeUrl === "string" && pluginConfig.bridgeUrl.length > 0
        ? pluginConfig.bridgeUrl
        : DEFAULT_BRIDGE_URL,
    callbackSecret:
      typeof pluginConfig.callbackSecret === "string" && pluginConfig.callbackSecret.length > 0
        ? pluginConfig.callbackSecret
        : undefined,
    apiToken:
      typeof pluginConfig.apiToken === "string" && pluginConfig.apiToken.length > 0
        ? pluginConfig.apiToken
        : undefined,
    requestTimeoutMs,
  };
}

/**
 * Callback signature protocol — MIRRORS src/jobs/callback-signature.ts.
 *
 * All three implementations must stay byte-for-byte equivalent:
 *   - src/jobs/callback-signature.ts        (server, source of truth)
 *   - omx-dispatch/index.ts
 *   - omx-bridge-plugin/index.ts            (this file)
 *
 * Protocol contract:
 *   header  = X-Callback-Signature
 *   value   = "sha256=" + hex(HMAC_SHA256(secret, jobId + ":" + body))
 *
 * Note: this plugin is sender-only. The body is JSON.stringify()-ed at the
 * call site and that exact string is both signed here AND sent as the HTTP
 * body. The receiver verifies against raw bytes, so don't re-stringify.
 *
 * If you change anything here, update the other two and the vectors in
 * test/unit/callback-signature.spec.ts in the same change.
 */
function buildCallbackSignatureHeader(
  secret: string,
  jobId: string,
  body: string,
): string {
  const message = `${jobId}:${body}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `sha256=${hex}`;
}

function buildBridgeUrl(api: OpenClawPluginApi, path: string): URL {
  const bridgeUrl = getPluginConfig(api).bridgeUrl ?? DEFAULT_BRIDGE_URL;
  return new URL(path, ensureTrailingSlash(bridgeUrl));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Bridge request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function requestJson<T>(
  api: OpenClawPluginApi,
  path: string,
  init?: RequestInit,
  signatureHeader?: string,
): Promise<T> {
  const pluginConfig = getPluginConfig(api);
  const response = await fetchWithTimeout(buildBridgeUrl(api, path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(pluginConfig.apiToken ? { Authorization: `Bearer ${pluginConfig.apiToken}` } : {}),
      ...(signatureHeader ? { "X-Callback-Signature": signatureHeader } : {}),
      ...(init?.headers ?? {}),
    },
  }, pluginConfig.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  const text = await response.text();
  const data = text.length > 0 ? safeJsonParse(text) : null;

  if (!response.ok) {
    const details =
      data && typeof data === "object" ? JSON.stringify(data, null, 2) : text || response.statusText;
    throw new Error(`Bridge request failed (${response.status} ${response.statusText}): ${details}`);
  }

  return data as T;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function toTextResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "OMX Bridge Plugin",
  description: "Agent tools for submitting, inspecting, listing, and cancelling jobs on omx-bridge.",
  configSchema: openClawConfigSchema,
  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "omx_submit_job",
      label: "Submit OMX Job",
      description: "Submit a new prompt to the local omx-bridge service and return the assigned job id.",
      parameters: submitJobParameters,
      async execute(_id: string, params: unknown) {
        const input = params as SubmitJobParameters;
        const result = await requestJson<CreateJobResponse>(api, "jobs", {
          method: "POST",
          body: JSON.stringify({
            prompt: input.prompt,
            source: "openclaw",
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.requestId ? { requestId: input.requestId } : {}),
            ...(input.originRoutingKey ? { originRoutingKey: input.originRoutingKey } : {}),
            ...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
            ...(input.sourceName ? { sourceName: input.sourceName } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          }),
        });

        return toTextResult(result);
      },
    });

    api.registerTool({
      name: "omx_get_job",
      label: "Get OMX Job",
      description: "Fetch the full status and result payload for a specific omx-bridge job.",
      parameters: jobIdParameters,
      async execute(_id: string, params: unknown) {
        const input = params as JobIdParameters;
        const result = await requestJson<BridgeJob>(api, `jobs/${encodeURIComponent(input.jobId)}`, {
          method: "GET",
        });

        return toTextResult(result);
      },
    });

    api.registerTool({
      name: "omx_list_jobs",
      label: "List OMX Jobs",
      description: "List omx-bridge jobs, optionally filtered by job status.",
      parameters: listJobsParameters,
      async execute(_id: string, params: unknown) {
        const input = params as ListJobsParameters;
        const search = new URLSearchParams();
        if (input.status) {
          search.set("status", input.status);
        }

        const suffix = search.size > 0 ? `?${search.toString()}` : "";
        const result = await requestJson<BridgeJob[]>(api, `jobs${suffix}`, {
          method: "GET",
        });

        return toTextResult(result);
      },
    });

    api.registerTool({
      name: "omx_cancel_job",
      label: "Cancel OMX Job",
      description: "Cancel a queued or running omx-bridge job and return the updated job record.",
      parameters: jobIdParameters,
      async execute(_id: string, params: unknown) {
        const input = params as JobIdParameters;
        const result = await requestJson<BridgeJob>(
          api,
          `jobs/${encodeURIComponent(input.jobId)}/cancel`,
          {
            method: "POST",
          },
        );

        return toTextResult(result);
      },
    });

    api.registerTool({
      name: "omx_callback_job",
      label: "Callback OMX Job",
      description: "Send a callback to mark an omx-bridge job as completed (used by external processes). Automatically signs the request with X-Callback-Signature when callbackSecret is configured.",
      parameters: Type.Object(
        {
          jobId: Type.String({ minLength: 1, description: "Bridge job identifier." }),
          status: Type.Union(
            [Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")],
            { description: "Terminal status to set on the job." },
          ),
          stdout: Type.Optional(Type.String({ description: "Standard output from the job." })),
          stderr: Type.Optional(Type.String({ description: "Standard error from the job." })),
          exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Exit code." })),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        const input = params as { jobId: string; status: string; stdout?: string; stderr?: string; exitCode?: number | null };
        const body = {
          status: input.status,
          ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
          ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
          ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        };
        // Stringify once; sign and send the SAME bytes so the receiver's
        // raw-body HMAC verification cannot drift on key reordering.
        const bodyText = JSON.stringify(body);

        const config = getPluginConfig(api);
        const signatureHeader = config.callbackSecret
          ? buildCallbackSignatureHeader(config.callbackSecret, input.jobId, bodyText)
          : undefined;

        const result = await requestJson<BridgeJob>(
          api,
          `jobs/${encodeURIComponent(input.jobId)}/callback`,
          {
            method: "POST",
            body: bodyText,
          },
          signatureHeader,
        );

        return toTextResult(result);
      },
    });
  },
});
