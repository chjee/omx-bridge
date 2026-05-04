import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import plugin, {
  BRIDGE_EXECUTION_ERROR_TYPES,
  JOB_EXECUTION_MODE_VALUES,
  JOB_SOURCE_VALUES,
  JOB_STATUS_VALUES,
  TMUX_SESSION_STATUS_VALUES,
} from "../index.js";

type PluginApi = Parameters<typeof plugin.register>[0];

type RegisteredTool = {
  name: string;
  execute: (id: string, params: unknown) => Promise<unknown>;
};

interface BridgeJobContract {
  jobStatuses: string[];
  jobExecutionModes: string[];
  executionErrorTypes: string[];
  tmuxSessionStatuses: string[];
  jobSources: string[];
  bridgeJob: Record<string, unknown>;
  bridgeJobSession: Record<string, unknown>;
}

async function loadContract(): Promise<BridgeJobContract> {
  const raw = await readFile(new URL("../../../contracts/bridge-job.contract.json", import.meta.url), "utf8");
  return JSON.parse(raw) as BridgeJobContract;
}

function createApi(config: Record<string, unknown> = {}) {
  const tools = new Map<string, RegisteredTool>();

  const api = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    runtime: {
      config: {
        loadConfig() {
          return {
            plugins: {
              entries: {
                "omx-bridge-plugin": {
                  config,
                },
              },
            },
          };
        },
      },
    },
  };

  return { api, tools };
}

test("OpenClaw plugin contract constants match the shared bridge fixture", async () => {
  const contract = await loadContract();

  assert.deepEqual([...JOB_STATUS_VALUES], contract.jobStatuses);
  assert.deepEqual([...JOB_EXECUTION_MODE_VALUES], contract.jobExecutionModes);
  assert.deepEqual([...BRIDGE_EXECUTION_ERROR_TYPES], contract.executionErrorTypes);
  assert.deepEqual([...TMUX_SESSION_STATUS_VALUES], contract.tmuxSessionStatuses);
  assert.deepEqual([...JOB_SOURCE_VALUES], contract.jobSources);
});

test("omx_get_job returns the shared full bridge job fixture without dropping fields", async () => {
  const contract = await loadContract();
  const { api, tools } = createApi({
    bridgeUrl: "http://127.0.0.1:3992",
    requestTimeoutMs: 100,
  });
  plugin.register(api as unknown as PluginApi);

  const getJob = tools.get("omx_get_job");
  assert.ok(getJob);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(contract.bridgeJob), {
      status: 200,
      statusText: "OK",
    });

  try {
    const result = await getJob.execute("call-1", { jobId: contract.bridgeJob.id });
    assert.deepEqual((result as { details: unknown }).details, contract.bridgeJob);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("omx_submit_job forwards OpenClaw routing fields to the bridge", async () => {
  const { api, tools } = createApi({
    bridgeUrl: "http://127.0.0.1:3992",
    requestTimeoutMs: 100,
  });
  plugin.register(api as unknown as PluginApi);

  const submitJob = tools.get("omx_submit_job");
  assert.ok(submitJob);

  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ jobId: "job-1", status: "queued" }), {
      status: 201,
      statusText: "Created",
    });
  };

  try {
    await submitJob.execute("call-1", {
      prompt: "ship this",
      executionMode: "tmux",
      cwd: "/workspace/project",
      requestId: "req-1",
      originRoutingKey: "telegram:direct:123",
      notifyUrl: "http://127.0.0.1:3994/notify",
      sourceName: "openclaw-telegram",
      metadata: { chatId: 123 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedUrl, "http://127.0.0.1:3992/jobs");
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    prompt: "ship this",
    source: "openclaw",
    executionMode: "tmux",
    cwd: "/workspace/project",
    requestId: "req-1",
    originRoutingKey: "telegram:direct:123",
    notifyUrl: "http://127.0.0.1:3994/notify",
    sourceName: "openclaw-telegram",
    metadata: { chatId: 123 },
  });
});

test("omx_get_job_session fetches compact tmux session details", async () => {
  const contract = await loadContract();
  const { api, tools } = createApi({
    bridgeUrl: "http://127.0.0.1:3992",
    requestTimeoutMs: 100,
  });
  plugin.register(api as unknown as PluginApi);

  const getSession = tools.get("omx_get_job_session");
  assert.ok(getSession);

  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify(contract.bridgeJobSession), {
      status: 200,
      statusText: "OK",
    });
  };

  let result: unknown;
  try {
    result = await getSession.execute("call-1", { jobId: contract.bridgeJobSession.jobId });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual((result as { details: unknown }).details, contract.bridgeJobSession);
  assert.equal(capturedUrl, `http://127.0.0.1:3992/jobs/${contract.bridgeJobSession.jobId}/session`);
  assert.equal(capturedInit?.method, "GET");
});
