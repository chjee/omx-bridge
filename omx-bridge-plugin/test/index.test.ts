import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.js";

type PluginApi = Parameters<typeof plugin.register>[0];

type RegisteredTool = {
  name: string;
  execute: (id: string, params: unknown) => Promise<unknown>;
};

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
    return new Response(JSON.stringify({
      jobId: "job-1",
      jobStatus: "running",
      executionMode: "tmux",
      attachCommand: "tmux attach -t omx-bridge-job-1",
      session: {
        backend: "tmux",
        sessionName: "omx-bridge-job-1",
        status: "running",
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:01.000Z",
        attachCommand: "tmux attach -t omx-bridge-job-1",
      },
    }), {
      status: 200,
      statusText: "OK",
    });
  };

  try {
    await getSession.execute("call-1", { jobId: "job-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedUrl, "http://127.0.0.1:3992/jobs/job-1/session");
  assert.equal(capturedInit?.method, "GET");
});
