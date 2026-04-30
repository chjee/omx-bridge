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
