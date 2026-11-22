import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeClient, type BridgeFetch } from "./bridge-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "Content-Type": "application/json" },
  });
}

test("adds JSON, bearer token, and callback signature headers", async () => {
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchImpl: BridgeFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ ok: true });
  };
  const client = new BridgeClient({
    baseUrl: "http://127.0.0.1:3992/api",
    apiToken: "bridge-token",
    timeoutMs: 1000,
    fetchImpl,
  });

  const result = await client.requestJson<{ ok: boolean }>(
    "jobs",
    {
      method: "POST",
      body: JSON.stringify({ prompt: "run" }),
      headers: { "X-Caller": "test" },
    },
    "sha256=abc",
  );

  const headers = new Headers(capturedInit?.headers);
  assert.deepEqual(result, { ok: true });
  assert.equal(capturedUrl?.toString(), "http://127.0.0.1:3992/api/jobs");
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("Authorization"), "Bearer bridge-token");
  assert.equal(headers.get("X-Callback-Signature"), "sha256=abc");
  assert.equal(headers.get("X-Caller"), "test");
});

test("parses empty successful responses as null", async () => {
  const client = new BridgeClient({
    baseUrl: "http://127.0.0.1:3992",
    timeoutMs: 1000,
    fetchImpl: async () => new Response(null, { status: 204, statusText: "No Content" }),
  });

  const result = await client.requestJson<null>("jobs/1", { method: "DELETE" });

  assert.equal(result, null);
});

test("formats non-2xx JSON response details", async () => {
  const client = new BridgeClient({
    baseUrl: "http://127.0.0.1:3992",
    timeoutMs: 1000,
    fetchImpl: async () => jsonResponse({ message: "bad request" }, { status: 400, statusText: "Bad Request" }),
  });

  await assert.rejects(
    () => client.requestJson("jobs", { method: "POST" }),
    /Bridge request failed \(400 Bad Request\): \{\n  "message": "bad request"\n\}/,
  );
});

test("formats non-JSON error response details", async () => {
  const client = new BridgeClient({
    baseUrl: "http://127.0.0.1:3992",
    timeoutMs: 1000,
    fetchImpl: async () => new Response("plain failure", { status: 502, statusText: "Bad Gateway" }),
  });

  await assert.rejects(
    () => client.requestJson("jobs/stats", { method: "GET" }),
    /Bridge request failed \(502 Bad Gateway\): plain failure/,
  );
});

test("requestJson preserves a body error that occurs before the timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bodyError = new DOMException("body stream aborted", "AbortError");
  let signal: AbortSignal | null | undefined;
  const fetchImpl: BridgeFetch = async (_url, init) => {
    signal = init?.signal;
    const response = new Response();
    response.text = async () => { throw bodyError; };
    return response;
  };
  const client = new BridgeClient({ baseUrl: "http://localhost", timeoutMs: 100, fetchImpl });
  await assert.rejects(client.requestJson("jobs/1"), (error) => error === bodyError);
  t.mock.timers.tick(100);
  assert.ok(signal);
  assert.equal(signal.aborted, false);
});

test("requestJson times out a pending body at the original request deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let bodySignal: AbortSignal | undefined;
  const fetchImpl: BridgeFetch = async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    t.mock.timers.tick(40);
    const response = new Response();
    response.text = () => {
      bodySignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    return response;
  };
  const client = new BridgeClient({ baseUrl: "http://localhost", timeoutMs: 100, fetchImpl });
  const request = client.requestJson("jobs/1");

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(bodySignal, "response body read has started");
  t.mock.timers.tick(59);
  assert.equal(bodySignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(bodySignal.aborted, true, "original request deadline must abort the body read");
  await assert.rejects(request, { message: "Bridge request timed out after 100ms" });
});

test("turns aborts into bridge timeout errors", async () => {
  const fetchImpl: BridgeFetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
  });
  const client = new BridgeClient({
    baseUrl: "http://127.0.0.1:3992",
    timeoutMs: 1,
    fetchImpl,
  });

  await assert.rejects(
    () => client.requestJson("jobs", { method: "GET" }),
    /Bridge request timed out after 1ms/,
  );
});
