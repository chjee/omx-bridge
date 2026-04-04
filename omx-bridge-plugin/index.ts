import { Type, type Static } from "@sinclair/typebox";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "omx-bridge-plugin";
const DEFAULT_BRIDGE_URL = "http://localhost:3000";
const JOB_STATUS_VALUES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

const pluginConfigSchema = Type.Object(
  {
    bridgeUrl: Type.Optional(
      Type.String({
        default: DEFAULT_BRIDGE_URL,
        description: "Base URL for the omx-bridge HTTP service.",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

const submitJobParameters = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      maxLength: 4000,
      description: "Prompt to submit to the omx-bridge service.",
    }),
    requestId: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "Optional request correlation identifier.",
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
  errorType?: "spawn_error" | "timeout" | "non_zero_exit" | "cancelled";
  recoveredFromRestart?: boolean;
}

interface BridgeJob {
  id: string;
  prompt: string;
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

  return {
    bridgeUrl:
      typeof pluginConfig.bridgeUrl === "string" && pluginConfig.bridgeUrl.length > 0
        ? pluginConfig.bridgeUrl
        : DEFAULT_BRIDGE_URL,
  };
}

function buildBridgeUrl(api: OpenClawPluginApi, path: string): URL {
  const bridgeUrl = getPluginConfig(api).bridgeUrl ?? DEFAULT_BRIDGE_URL;
  return new URL(path, ensureTrailingSlash(bridgeUrl));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function requestJson<T>(
  api: OpenClawPluginApi,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(buildBridgeUrl(api, path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

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

function toTextResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "OMX Bridge Plugin",
  description: "Agent tools for submitting, inspecting, listing, and cancelling jobs on omx-bridge.",
  configSchema: pluginConfigSchema,
  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "omx_submit_job",
      description: "Submit a new prompt to the local omx-bridge service and return the assigned job id.",
      parameters: submitJobParameters,
      async execute(_id: string, params: SubmitJobParameters) {
        const result = await requestJson<CreateJobResponse>(api, "jobs", {
          method: "POST",
          body: JSON.stringify({
            prompt: params.prompt,
            ...(params.requestId ? { requestId: params.requestId } : {}),
            ...(params.metadata ? { metadata: params.metadata } : {}),
          }),
        });

        return toTextResult(result);
      },
    });

    api.registerTool({
      name: "omx_get_job",
      description: "Fetch the full status and result payload for a specific omx-bridge job.",
      parameters: jobIdParameters,
      async execute(_id: string, params: JobIdParameters) {
        const result = await requestJson<BridgeJob>(api, `jobs/${encodeURIComponent(params.jobId)}`, {
          method: "GET",
        });

        return toTextResult(result);
      },
    });

    api.registerTool({
      name: "omx_list_jobs",
      description: "List omx-bridge jobs, optionally filtered by job status.",
      parameters: listJobsParameters,
      async execute(_id: string, params: ListJobsParameters) {
        const search = new URLSearchParams();
        if (params.status) {
          search.set("status", params.status);
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
      description: "Cancel a queued or running omx-bridge job and return the updated job record.",
      parameters: jobIdParameters,
      async execute(_id: string, params: JobIdParameters) {
        const result = await requestJson<BridgeJob>(
          api,
          `jobs/${encodeURIComponent(params.jobId)}/cancel`,
          {
            method: "POST",
          },
        );

        return toTextResult(result);
      },
    });
  },
});
