import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  DEFAULT_BRIDGE_URL,
  DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE,
  DEFAULT_WEBHOOK_BODY_LIMIT_BYTES,
  loadRuntimeConfig,
  parseBoolean,
  parsePositiveInt,
} from "./runtime-config.js";

test("rejects runtime defaults without required bridge auth material", () => {
  assert.throws(
    () => loadRuntimeConfig({}, "/workspace/omx-bridge"),
    /BRIDGE_API_TOKEN is required unless OMX_DISPATCH_INSECURE_LOOPBACK=1/,
  );
});

test("rejects missing callback secret when bridge API token is present", () => {
  assert.throws(
    () => loadRuntimeConfig({ BRIDGE_API_TOKEN: "api-token" }, "/workspace/omx-bridge"),
    /BRIDGE_CALLBACK_SECRET is required unless OMX_DISPATCH_INSECURE_LOOPBACK=1/,
  );
});

test("loads runtime defaults with explicit insecure loopback opt-in", () => {
  const config = loadRuntimeConfig({
    OMX_DISPATCH_INSECURE_LOOPBACK: "1",
  }, "/workspace/omx-bridge");

  assert.equal(config.serverVersion, "0.1.0");
  assert.equal(config.bridgeUrl, DEFAULT_BRIDGE_URL);
  assert.equal(config.bridgeCallbackSecret, "");
  assert.equal(config.bridgeApiToken, "");
  assert.equal(config.insecureLoopback, true);
  assert.equal(config.bridgeRequestTimeoutMs, 10_000);
  assert.equal(config.webhookPort, 0);
  assert.equal(config.webhookPortMin, 12000);
  assert.equal(config.webhookPortMax, 12999);
  assert.equal(config.webhookBodyLimitBytes, DEFAULT_WEBHOOK_BODY_LIMIT_BYTES);
  assert.equal(config.enableClaudeChannel, false);
  assert.equal(config.maxNotificationQueueSize, DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE);
  assert.equal(
    config.notificationStorePath,
    path.join("/workspace/omx-bridge", ".omx", "state", "omx-dispatch-notifications.jsonl"),
  );
  assert.equal(config.defaultWaitTimeoutMs, 300_000);
  assert.equal(config.defaultWaitPollIntervalMs, 1_000);
  assert.equal(config.maxWaitTimeoutMs, 3_600_000);
  assert.equal(config.minWaitPollIntervalMs, 250);
  assert.equal(config.maxWaitPollIntervalMs, 10_000);
  assert.equal(config.terminalNotificationGraceMs, 2_000);
});

test("rejects insecure loopback opt-in for non-loopback bridge URLs", () => {
  assert.throws(
    () => loadRuntimeConfig({
      BRIDGE_URL: "http://192.0.2.10:3992",
      OMX_DISPATCH_INSECURE_LOOPBACK: "1",
    }, "/workspace/omx-bridge"),
    /OMX_DISPATCH_INSECURE_LOOPBACK is only allowed for loopback BRIDGE_URL/,
  );
});

test("loads runtime overrides from environment", () => {
  const config = loadRuntimeConfig({
    BRIDGE_URL: "http://127.0.0.1:4999",
    BRIDGE_CALLBACK_SECRET: "callback-secret",
    BRIDGE_API_TOKEN: "api-token",
    BRIDGE_REQUEST_TIMEOUT_MS: "2500",
    WEBHOOK_PORT: "12345",
    OMX_DISPATCH_WEBHOOK_BODY_LIMIT_BYTES: "123456",
    ENABLE_CLAUDE_CHANNEL: "yes",
    MAX_NOTIFICATION_QUEUE_SIZE: "7",
    OMX_DISPATCH_NOTIFICATION_STORE_PATH: "/tmp/custom-notifications.jsonl",
    OMX_DISPATCH_WAIT_TIMEOUT_MS: "9999",
    OMX_DISPATCH_WAIT_POLL_INTERVAL_MS: "333",
  }, "/workspace/omx-bridge");

  assert.equal(config.bridgeUrl, "http://127.0.0.1:4999");
  assert.equal(config.bridgeCallbackSecret, "callback-secret");
  assert.equal(config.bridgeApiToken, "api-token");
  assert.equal(config.insecureLoopback, false);
  assert.equal(config.bridgeRequestTimeoutMs, 2500);
  assert.equal(config.webhookPort, 12345);
  assert.equal(config.webhookBodyLimitBytes, 123456);
  assert.equal(config.enableClaudeChannel, true);
  assert.equal(config.maxNotificationQueueSize, 7);
  assert.equal(config.notificationStorePath, "/tmp/custom-notifications.jsonl");
  assert.equal(config.defaultWaitTimeoutMs, 9999);
  assert.equal(config.defaultWaitPollIntervalMs, 333);
});

test("positive integer parsing falls back for missing or invalid values", () => {
  assert.equal(parsePositiveInt(undefined, 10), 10);
  assert.equal(parsePositiveInt("", 10), 10);
  assert.equal(parsePositiveInt("0", 10), 10);
  assert.equal(parsePositiveInt("-1", 10), 10);
  assert.equal(parsePositiveInt("abc", 10), 10);
  assert.equal(parsePositiveInt("42", 10), 42);
});

test("boolean parsing accepts only explicit truthy values", () => {
  assert.equal(parseBoolean(undefined), false);
  assert.equal(parseBoolean(""), false);
  assert.equal(parseBoolean("0"), false);
  assert.equal(parseBoolean("false"), false);
  assert.equal(parseBoolean("1"), true);
  assert.equal(parseBoolean("true"), true);
  assert.equal(parseBoolean("TRUE"), true);
  assert.equal(parseBoolean("yes"), true);
  assert.equal(parseBoolean("YES"), true);
});

test("invalid positive integer env values fall back without rejecting other overrides", () => {
  const config = loadRuntimeConfig({
    BRIDGE_URL: "http://127.0.0.1:4999",
    BRIDGE_CALLBACK_SECRET: "callback-secret",
    BRIDGE_API_TOKEN: "api-token",
    BRIDGE_REQUEST_TIMEOUT_MS: "invalid",
    OMX_DISPATCH_WEBHOOK_BODY_LIMIT_BYTES: "0",
    MAX_NOTIFICATION_QUEUE_SIZE: "-5",
    OMX_DISPATCH_WAIT_TIMEOUT_MS: "NaN",
    OMX_DISPATCH_WAIT_POLL_INTERVAL_MS: "",
  }, "/workspace/omx-bridge");

  assert.equal(config.bridgeUrl, "http://127.0.0.1:4999");
  assert.equal(config.bridgeRequestTimeoutMs, 10_000);
  assert.equal(config.webhookBodyLimitBytes, DEFAULT_WEBHOOK_BODY_LIMIT_BYTES);
  assert.equal(config.maxNotificationQueueSize, DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE);
  assert.equal(config.defaultWaitTimeoutMs, 300_000);
  assert.equal(config.defaultWaitPollIntervalMs, 1_000);
});
