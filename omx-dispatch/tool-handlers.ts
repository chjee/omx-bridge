import type { JobNotification, NotificationStats } from "./notification-store.js";

export const JOB_STATUS_VALUES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUS_VALUES)[number];

export interface BridgeJobExecution {
  command: string;
  timeoutMs: number;
  maxOutputChars: number;
  durationMs?: number;
  timedOut?: boolean;
  outputTruncated?: boolean;
  errorType?: "spawn_error" | "timeout" | "non_zero_exit" | "cancelled" | "execution_error" | "invalid_cwd";
  recoveredFromRestart?: boolean;
}

export type JobSource = "dispatch" | "channel" | "synapse" | "openclaw";

export interface BridgeJob {
  id: string;
  prompt: string;
  cwd?: string;
  queueOrder: string;
  requestId?: string;
  originRoutingKey?: string;
  source?: JobSource;
  sourceName?: string;
  notifyUrl?: string;
  metadata?: Record<string, unknown>;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  execution: BridgeJobExecution;
}

export interface CreateJobResponse {
  jobId: string;
  status: JobStatus;
}

export interface BridgeJobStats {
  queuedCount: number;
  runningCount: number;
  activeCount: number;
  terminalCount: number;
  maxActiveJobs: number;
  maxConcurrency: number;
  oldestQueuedAgeMs: number | null;
}

export interface SubmitJobInput {
  prompt: string;
  cwd?: string;
  requestId?: string;
  originRoutingKey?: string;
  metadata?: Record<string, unknown>;
  notifyUrl?: string;
  source?: JobSource;
  sourceName?: string;
}

export interface WaitForJobOptions {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface WaitForJobResult {
  jobId: string;
  status: JobStatus;
  completed: boolean;
  timedOut: boolean;
  notification: JobNotification<BridgeJob> | null;
  job: BridgeJob;
  notificationMissing?: boolean;
}

export interface DispatchHealthResult {
  bridge: {
    reachable: boolean;
    url: string;
    stats?: BridgeJobStats;
    error?: string;
  };
  notifications: NotificationStats<JobStatus>;
}

export interface CallbackJobInput {
  jobId: string;
  status: "succeeded" | "failed" | "cancelled";
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

export interface DispatchToolConfig {
  jobStatusValues: readonly JobStatus[];
  maxWaitTimeoutMs: number;
  minWaitPollIntervalMs: number;
  maxWaitPollIntervalMs: number;
  notificationPreviewMax: number;
}

export interface DispatchToolDependencies {
  config: DispatchToolConfig;
  submitBridgeJob: (input: SubmitJobInput) => Promise<CreateJobResponse>;
  getBridgeJob: (jobId: string) => Promise<BridgeJob>;
  waitForJobCompletion: (jobId: string, options?: WaitForJobOptions) => Promise<WaitForJobResult>;
  listBridgeJobs: (status?: JobStatus) => Promise<BridgeJob[]>;
  cancelBridgeJob: (jobId: string) => Promise<BridgeJob>;
  callbackBridgeJob: (input: CallbackJobInput) => Promise<BridgeJob>;
  drainNotifications: () => Promise<Array<JobNotification<BridgeJob>>>;
  getDispatchHealth: () => Promise<DispatchHealthResult>;
  getNotificationStats: (previewCount?: number) => Promise<NotificationStats<JobStatus>>;
}

export function createDispatchToolHandlers(deps: DispatchToolDependencies): {
  listTools: () => Promise<{ tools: unknown[] }>;
  callTool: (request: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
} {
  return {
    listTools: async () => ({ tools: buildTools(deps.config) }),
    callTool: async (request) => callTool(request, deps),
  };
}

function buildTools(config: DispatchToolConfig): unknown[] {
  const submitAndWaitInputSchema = submitJobInputSchema(
    "Webhook URL to receive job completion callback. Defaults to the MCP server's local webhook.",
  );

  return [
    {
      name: "omx_submit_job",
      description:
        "Submit a new prompt to the local omx-bridge service and return the assigned job id. Use this for coding, implementation, testing, and any development tasks that should be delegated to OMX.",
      inputSchema: submitJobInputSchema(
        "Webhook URL to receive job completion callback. Defaults to the MCP server's local webhook. Pass the caller's own notify endpoint when the callback must be routed to a different process (e.g. synapse routing).",
      ),
    },
    {
      name: "omx_submit_job_and_wait",
      description:
        "Submit a new prompt to the local omx-bridge service, then wait for that specific job to complete. Use this in interactive CLI sessions when the user expects the completion result in the same flow.",
      inputSchema: {
        ...submitAndWaitInputSchema,
        properties: {
          ...submitAndWaitInputSchema.properties,
          waitTimeoutMs: {
            type: "number",
            minimum: 1,
            maximum: config.maxWaitTimeoutMs,
            description: "Maximum time to wait for this job to complete. Defaults to OMX_DISPATCH_WAIT_TIMEOUT_MS or 300000.",
          },
          pollIntervalMs: {
            type: "number",
            minimum: config.minWaitPollIntervalMs,
            maximum: config.maxWaitPollIntervalMs,
            description: "Polling interval while waiting. Defaults to OMX_DISPATCH_WAIT_POLL_INTERVAL_MS or 1000.",
          },
        },
      },
    },
    {
      name: "omx_get_job",
      description: "Fetch the full status and result payload for a specific omx-bridge job.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            minLength: 1,
            description: "Bridge job identifier.",
          },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
    {
      name: "omx_wait_for_job",
      description:
        "Wait for an existing omx-bridge job to complete. Drains only that job's notification from the shared notification store and leaves other pending notifications untouched.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            minLength: 1,
            description: "Bridge job identifier.",
          },
          waitTimeoutMs: {
            type: "number",
            minimum: 1,
            maximum: config.maxWaitTimeoutMs,
            description: "Maximum time to wait for this job to complete. Defaults to OMX_DISPATCH_WAIT_TIMEOUT_MS or 300000.",
          },
          pollIntervalMs: {
            type: "number",
            minimum: config.minWaitPollIntervalMs,
            maximum: config.maxWaitPollIntervalMs,
            description: "Polling interval while waiting. Defaults to OMX_DISPATCH_WAIT_POLL_INTERVAL_MS or 1000.",
          },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
    {
      name: "omx_list_jobs",
      description: "List omx-bridge jobs, optionally filtered by job status.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...config.jobStatusValues],
            description: "Optional status filter.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "omx_cancel_job",
      description: "Cancel a queued or running omx-bridge job and return the updated job record.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            minLength: 1,
            description: "Bridge job identifier.",
          },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
    {
      name: "omx_callback_job",
      description:
        "Send a callback to mark an omx-bridge job as completed. Automatically signs the request with X-Callback-Signature when BRIDGE_CALLBACK_SECRET is configured.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            minLength: 1,
            description: "Bridge job identifier.",
          },
          status: {
            type: "string",
            enum: ["succeeded", "failed", "cancelled"],
            description: "Terminal status to set on the job.",
          },
          stdout: {
            type: "string",
            description: "Standard output from the job.",
          },
          stderr: {
            type: "string",
            description: "Standard error from the job.",
          },
          exitCode: {
            type: ["number", "null"],
            description: "Exit code.",
          },
        },
        required: ["jobId", "status"],
        additionalProperties: false,
      },
    },
    {
      name: "omx_get_notifications",
      description:
        "Return all pending job-completion notifications received via the shared webhook notification store and clear the queue. Call this to check whether any OMX jobs have finished since the last poll.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "omx_health",
      description:
        "Return a compact operational health summary for omx-dispatch and the local omx-bridge service, including bridge job stats and pending completion notifications.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "omx_notification_stats",
      description:
        "Inspect the shared job-completion notification store without draining it. Use this to see whether pending OMX completion notifications exist and optionally preview a bounded subset.",
      inputSchema: {
        type: "object",
        properties: {
          previewCount: {
            type: "number",
            minimum: 0,
            maximum: config.notificationPreviewMax,
            description: "Number of pending notifications to preview without draining. Defaults to 0.",
          },
        },
        additionalProperties: false,
      },
    },
  ];
}

function submitJobInputSchema(notifyUrlDescription: string): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
} {
  return {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
        description: "Prompt to submit to the omx-bridge service.",
      },
      cwd: {
        type: "string",
        description: "Working directory for the job (absolute path).",
      },
      requestId: {
        type: "string",
        maxLength: 200,
        description: "Optional request correlation identifier.",
      },
      metadata: {
        type: "object",
        description: "Optional metadata passed through to the bridge (e.g. chat_id, source).",
        additionalProperties: true,
      },
      originRoutingKey: {
        type: "string",
        maxLength: 200,
        description: "Routing key of the conversation that initiated this job (e.g. 'telegram:direct:123456'). Channel brokers use this to route the callback result back to the correct chat.",
      },
      notifyUrl: {
        type: "string",
        description: notifyUrlDescription,
      },
      source: {
        type: "string",
        enum: ["dispatch", "channel", "synapse", "openclaw"],
        description: "Caller class. Use 'dispatch' for Claude Code CLI sessions and 'channel' for broker-owned channel routing.",
      },
      sourceName: {
        type: "string",
        maxLength: 200,
        description: "Optional concrete channel broker name when source is 'channel', e.g. 'claude-chopper'.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  };
}

async function callTool(
  request: unknown,
  deps: DispatchToolDependencies,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { name, args } = parseToolRequest(request);

  switch (name) {
    case "omx_submit_job": {
      const result = await deps.submitBridgeJob(args as unknown as SubmitJobInput);
      return toTextResult(result);
    }

    case "omx_submit_job_and_wait": {
      const { waitTimeoutMs, pollIntervalMs, ...input } = args as unknown as SubmitJobInput & WaitForJobOptions;
      const submitted = await deps.submitBridgeJob(input);
      const waited = await deps.waitForJobCompletion(submitted.jobId, {
        waitTimeoutMs,
        pollIntervalMs,
      });
      return toTextResult(waited);
    }

    case "omx_get_job": {
      const { jobId } = args as { jobId: string };
      const result = await deps.getBridgeJob(jobId);
      return toTextResult(result);
    }

    case "omx_wait_for_job": {
      const { jobId, waitTimeoutMs, pollIntervalMs } = args as {
        jobId: string;
        waitTimeoutMs?: number;
        pollIntervalMs?: number;
      };
      const result = await deps.waitForJobCompletion(jobId, {
        waitTimeoutMs,
        pollIntervalMs,
      });
      return toTextResult(result);
    }

    case "omx_list_jobs": {
      const { status } = args as { status?: JobStatus };
      const result = await deps.listBridgeJobs(status);
      return toTextResult(result);
    }

    case "omx_cancel_job": {
      const { jobId } = args as { jobId: string };
      const result = await deps.cancelBridgeJob(jobId);
      return toTextResult(result);
    }

    case "omx_callback_job": {
      const result = await deps.callbackBridgeJob(args as unknown as CallbackJobInput);
      return toTextResult(result);
    }

    case "omx_get_notifications": {
      const pending = await deps.drainNotifications();
      return toTextResult({ count: pending.length, notifications: pending });
    }

    case "omx_health": {
      const result = await deps.getDispatchHealth();
      return toTextResult(result);
    }

    case "omx_notification_stats": {
      const { previewCount } = args as { previewCount?: number };
      const result = await deps.getNotificationStats(
        typeof previewCount === "number" && Number.isFinite(previewCount) ? previewCount : 0,
      );
      return toTextResult(result);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function parseToolRequest(request: unknown): { name: string; args: Record<string, unknown> } {
  if (!isRecord(request) || !isRecord(request["params"])) {
    throw new Error("Invalid tool request");
  }
  const { name } = request["params"];
  if (typeof name !== "string") {
    throw new Error("Invalid tool name");
  }
  const rawArgs = request["params"]["arguments"];
  return {
    name,
    args: isRecord(rawArgs) ? rawArgs : {},
  };
}

function toTextResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
