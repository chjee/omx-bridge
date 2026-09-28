import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_BRIDGE_URL,
  DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE,
  DEFAULT_SERVER_VERSION,
  DEFAULT_WEBHOOK_BODY_LIMIT_BYTES,
  DISPATCH_PACKAGE_VERSION,
  loadDispatchPackageVersion,
  loadRuntimeConfig,
  parseBoolean,
  parsePositiveInt,
} from "./runtime-config.js";

const dispatchPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const STRICT_POSITIVE_INT_ENV_VARS = [
  "BRIDGE_REQUEST_TIMEOUT_MS",
  "OMX_DISPATCH_WEBHOOK_BODY_LIMIT_BYTES",
  "MAX_NOTIFICATION_QUEUE_SIZE",
  "OMX_DISPATCH_WAIT_TIMEOUT_MS",
  "OMX_DISPATCH_WAIT_POLL_INTERVAL_MS",
] as const;

const INVALID_POSITIVE_INT_VALUES = [
  "0",
  "-1",
  "1.5",
  "500ms",
  "NaN",
  "9007199254740992",
] as const;

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

  assert.equal(config.serverVersion, dispatchPackage.version);
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

test("loads the dispatch package version from production and test build layouts", () => {
  const productionModuleUrl = new URL("../dist/runtime-config.js", import.meta.url);
  const testModuleUrl = new URL("../dist-test/runtime-config.js", import.meta.url);

  assert.equal(loadDispatchPackageVersion(productionModuleUrl), dispatchPackage.version);
  assert.equal(loadDispatchPackageVersion(testModuleUrl), dispatchPackage.version);
  assert.equal(DISPATCH_PACKAGE_VERSION, dispatchPackage.version);
  assert.equal(DEFAULT_SERVER_VERSION, dispatchPackage.version);
});

test("fails clearly when dispatch package metadata is malformed or has no version", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dispatch-version-"));
  const distDirectory = path.join(root, "dist");
  const moduleUrl = pathToFileURL(path.join(distDirectory, "runtime-config.js"));
  mkdirSync(distDirectory);

  try {
    writeFileSync(path.join(root, "package.json"), "{not-json", "utf8");
    assert.throws(
      () => loadDispatchPackageVersion(moduleUrl),
      /Failed to read omx-dispatch package metadata/,
    );

    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "omx-dispatch" }), "utf8");
    assert.throws(
      () => loadDispatchPackageVersion(moduleUrl),
      /must contain a non-empty version/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("positive integer parsing keeps defaults for missing or empty values", () => {
  assert.equal(parsePositiveInt(undefined, 10), 10);
  assert.equal(parsePositiveInt("", 10), 10);
  assert.equal(parsePositiveInt("   ", 10), 10);
  assert.equal(parsePositiveInt("42", 10), 42);
});

test("positive integer parsing rejects explicit invalid values", () => {
  for (const value of INVALID_POSITIVE_INT_VALUES) {
    assert.throws(
      () => parsePositiveInt(value, 10, "TEST_VALUE"),
      /TEST_VALUE/,
    );
  }
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

test("empty numeric env values keep documented defaults", () => {
  const config = loadRuntimeConfig({
    BRIDGE_URL: "http://127.0.0.1:4999",
    BRIDGE_CALLBACK_SECRET: "callback-secret",
    BRIDGE_API_TOKEN: "api-token",
    BRIDGE_REQUEST_TIMEOUT_MS: "",
    WEBHOOK_PORT: " ",
    OMX_DISPATCH_WEBHOOK_BODY_LIMIT_BYTES: " ",
    MAX_NOTIFICATION_QUEUE_SIZE: "",
    OMX_DISPATCH_WAIT_TIMEOUT_MS: " ",
    OMX_DISPATCH_WAIT_POLL_INTERVAL_MS: "",
  }, "/workspace/omx-bridge");

  assert.equal(config.bridgeUrl, "http://127.0.0.1:4999");
  assert.equal(config.bridgeRequestTimeoutMs, 10_000);
  assert.equal(config.webhookPort, 0);
  assert.equal(config.webhookBodyLimitBytes, DEFAULT_WEBHOOK_BODY_LIMIT_BYTES);
  assert.equal(config.maxNotificationQueueSize, DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE);
  assert.equal(config.defaultWaitTimeoutMs, 300_000);
  assert.equal(config.defaultWaitPollIntervalMs, 1_000);
});

test("explicit invalid positive integer env values fail fast", () => {
  for (const envName of STRICT_POSITIVE_INT_ENV_VARS) {
    for (const value of INVALID_POSITIVE_INT_VALUES) {
      assert.throws(
        () => loadRuntimeConfig({
          BRIDGE_CALLBACK_SECRET: "callback-secret",
          BRIDGE_API_TOKEN: "api-token",
          [envName]: value,
        }),
        new RegExp(envName),
      );
    }
  }
});

test("WEBHOOK_PORT accepts 0..65535 and rejects other explicit values", () => {
  const auth = {
    BRIDGE_CALLBACK_SECRET: "callback-secret",
    BRIDGE_API_TOKEN: "api-token",
  };
  assert.equal(loadRuntimeConfig({ ...auth, WEBHOOK_PORT: "0" }).webhookPort, 0);
  assert.equal(loadRuntimeConfig({ ...auth, WEBHOOK_PORT: "65535" }).webhookPort, 65535);

  for (const value of ["-1", "65536", "1.5", "123abc", "NaN", "9007199254740992"]) {
    assert.throws(
      () => loadRuntimeConfig({ ...auth, WEBHOOK_PORT: value }),
      /WEBHOOK_PORT/,
    );
  }
});
