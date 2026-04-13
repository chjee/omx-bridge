#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

const DEFAULT_BRIDGE_URL = "http://localhost:3992";
const BRIDGE_URL = process.env["BRIDGE_URL"] ?? DEFAULT_BRIDGE_URL;
const BRIDGE_CALLBACK_SECRET = process.env["BRIDGE_CALLBACK_SECRET"] ?? "";

const JOB_STATUS_VALUES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
type JobStatus = (typeof JOB_STATUS_VALUES)[number];

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

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
  cwd?: string;
  queueOrder: string;
  requestId?: string;
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

interface CreateJobResponse {
  jobId: string;
  status: JobStatus;
}

// ---------------------------------------------------------------------------
// HTTP 헬퍼
// ---------------------------------------------------------------------------

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildBridgeUrl(path: string): URL {
  return new URL(path, ensureTrailingSlash(BRIDGE_URL));
}

function buildCallbackSignatureHeader(jobId: string, body: unknown): string {
  const message = `${jobId}:${JSON.stringify(body)}`;
  const hex = createHmac("sha256", BRIDGE_CALLBACK_SECRET).update(message).digest("hex");
  return `sha256=${hex}`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
  signatureHeader?: string,
): Promise<T> {
  const response = await fetch(buildBridgeUrl(path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(signatureHeader ? { "X-Callback-Signature": signatureHeader } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  const data = text.length > 0 ? safeJsonParse(text) : null;

  if (!response.ok) {
    const details =
      data && typeof data === "object"
        ? JSON.stringify(data, null, 2)
        : text || response.statusText;
    throw new Error(`Bridge request failed (${response.status} ${response.statusText}): ${details}`);
  }

  return data as T;
}

function toTextResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// MCP 서버
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "omx-bridge-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// 도구 목록
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "omx_submit_job",
      description:
        "Submit a new prompt to the local omx-bridge service and return the assigned job id. Use this for coding, implementation, testing, and any development tasks that should be delegated to OMX.",
      inputSchema: {
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
        },
        required: ["prompt"],
        additionalProperties: false,
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
      name: "omx_list_jobs",
      description: "List omx-bridge jobs, optionally filtered by job status.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...JOB_STATUS_VALUES],
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
  ],
}));

// ---------------------------------------------------------------------------
// 도구 실행
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "omx_submit_job": {
      const { prompt, cwd, requestId, metadata } = args as {
        prompt: string;
        cwd?: string;
        requestId?: string;
        metadata?: Record<string, unknown>;
      };
      const result = await requestJson<CreateJobResponse>("jobs", {
        method: "POST",
        body: JSON.stringify({
          prompt,
          ...(cwd ? { cwd } : {}),
          ...(requestId ? { requestId } : {}),
          ...(metadata ? { metadata } : {}),
        }),
      });
      return toTextResult(result);
    }

    case "omx_get_job": {
      const { jobId } = args as { jobId: string };
      const result = await requestJson<BridgeJob>(
        `jobs/${encodeURIComponent(jobId)}`,
        { method: "GET" },
      );
      return toTextResult(result);
    }

    case "omx_list_jobs": {
      const { status } = args as { status?: JobStatus };
      const search = new URLSearchParams();
      if (status) search.set("status", status);
      const suffix = search.size > 0 ? `?${search.toString()}` : "";
      const result = await requestJson<BridgeJob[]>(`jobs${suffix}`, { method: "GET" });
      return toTextResult(result);
    }

    case "omx_cancel_job": {
      const { jobId } = args as { jobId: string };
      const result = await requestJson<BridgeJob>(
        `jobs/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST" },
      );
      return toTextResult(result);
    }

    case "omx_callback_job": {
      const { jobId, status, stdout, stderr, exitCode } = args as {
        jobId: string;
        status: "succeeded" | "failed" | "cancelled";
        stdout?: string;
        stderr?: string;
        exitCode?: number | null;
      };
      const body = {
        status,
        ...(stdout !== undefined ? { stdout } : {}),
        ...(stderr !== undefined ? { stderr } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
      const signatureHeader = BRIDGE_CALLBACK_SECRET
        ? buildCallbackSignatureHeader(jobId, body)
        : undefined;
      const result = await requestJson<BridgeJob>(
        `jobs/${encodeURIComponent(jobId)}/callback`,
        { method: "POST", body: JSON.stringify(body) },
        signatureHeader,
      );
      return toTextResult(result);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
