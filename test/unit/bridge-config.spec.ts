import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_OMX_ENV_ALLOWLIST,
  DEFAULT_REQUEST_BODY_LIMIT,
  buildBridgeConfig,
} from '../../src/config/bridge-config';

describe('buildBridgeConfig', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses documented defaults when env vars are unset', () => {
    process.env = {};

    const config = buildBridgeConfig(new ConfigService(), '/workspace/app', '/home/tester');

    expect(config).toEqual({
      host: '127.0.0.1',
      requestBodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
      jobsDirectory: '/workspace/app/.omx/state/bridge-jobs',
      omxCommand: 'omx',
      omxEnvAllowlist: DEFAULT_OMX_ENV_ALLOWLIST,
      jobPollIntervalMs: 500,
      jobTimeoutMs: 900000,
      maxOutputChars: 32000,
      sigkillGraceMs: 5000,
      maxConcurrency: 2,
      maxActiveJobs: 50,
      jobRetentionDays: 7,
      maxTerminalJobs: 1000,
      jobCleanupIntervalMs: 3600000,
      notifyRetryDelaysMs: [500, 1000, 2000],
      notifyTimeoutMs: 5000,
      notifyMode: 'openclaw',
      callbackSecret: undefined,
      apiToken: undefined,
      allowedCwdPrefixes: ['/home/tester'],
      claudeNotifyUrl: undefined,
    });
  });

  it('uses env overrides when present', () => {
    process.env = {
      BRIDGE_JOBS_DIR: '/tmp/custom-jobs',
      BRIDGE_HOST: 'localhost',
      BRIDGE_REQUEST_BODY_LIMIT: '2mb',
      OMX_COMMAND: 'omx-custom',
      BRIDGE_OMX_ENV_ALLOWLIST: 'PATH,HOME,CUSTOM_ENV,PATH',
      BRIDGE_JOB_POLL_INTERVAL_MS: '250',
      BRIDGE_JOB_TIMEOUT_MS: '1234',
      BRIDGE_MAX_OUTPUT_CHARS: '999',
      BRIDGE_SIGKILL_GRACE_MS: '7500',
      BRIDGE_MAX_CONCURRENCY: '4',
      BRIDGE_MAX_ACTIVE_JOBS: '25',
      BRIDGE_JOB_RETENTION_DAYS: '3',
      BRIDGE_MAX_TERMINAL_JOBS: '250',
      BRIDGE_JOB_CLEANUP_INTERVAL_MS: '60000',
      BRIDGE_NOTIFY_RETRY_DELAYS_MS: '10,20,40',
      BRIDGE_NOTIFY_TIMEOUT_MS: '3000',
      BRIDGE_API_TOKEN: 'token-xyz',
      BRIDGE_ALLOWED_CWD_PREFIXES: '~/workspace,/srv/projects',
    };

    const config = buildBridgeConfig(new ConfigService(), '/workspace/app', '/home/tester');

    expect(config).toEqual({
      host: 'localhost',
      requestBodyLimit: '2mb',
      jobsDirectory: '/tmp/custom-jobs',
      omxCommand: 'omx-custom',
      omxEnvAllowlist: ['PATH', 'HOME', 'CUSTOM_ENV'],
      jobPollIntervalMs: 250,
      jobTimeoutMs: 1234,
      maxOutputChars: 999,
      sigkillGraceMs: 7500,
      maxConcurrency: 4,
      maxActiveJobs: 25,
      jobRetentionDays: 3,
      maxTerminalJobs: 250,
      jobCleanupIntervalMs: 60000,
      notifyRetryDelaysMs: [10, 20, 40],
      notifyTimeoutMs: 3000,
      notifyMode: 'openclaw',
      callbackSecret: undefined,
      apiToken: 'token-xyz',
      allowedCwdPrefixes: ['/home/tester/workspace', '/srv/projects'],
      claudeNotifyUrl: undefined,
    });
  });

  it('falls back to the default request body limit for invalid values', () => {
    process.env = {
      BRIDGE_REQUEST_BODY_LIMIT: 'not a size',
    };

    const config = buildBridgeConfig(new ConfigService(), '/workspace/app', '/home/tester');

    expect(config.requestBodyLimit).toBe(DEFAULT_REQUEST_BODY_LIMIT);
  });

  it('rejects non-loopback hosts without API token', () => {
    process.env = {
      BRIDGE_HOST: '0.0.0.0',
      BRIDGE_CALLBACK_SECRET: 'secret',
    };

    expect(() => buildBridgeConfig(new ConfigService(), '/workspace/app', '/home/tester')).toThrow(
      'BRIDGE_API_TOKEN is required when BRIDGE_HOST is not loopback',
    );
  });

  it('rejects non-loopback hosts without callback secret', () => {
    process.env = {
      BRIDGE_HOST: '0.0.0.0',
      BRIDGE_API_TOKEN: 'token',
    };

    expect(() => buildBridgeConfig(new ConfigService(), '/workspace/app', '/home/tester')).toThrow(
      'BRIDGE_CALLBACK_SECRET is required when BRIDGE_HOST is not loopback',
    );
  });

  it('accepts non-loopback hosts with API token and callback secret', () => {
    process.env = {
      BRIDGE_HOST: '0.0.0.0',
      BRIDGE_API_TOKEN: 'token',
      BRIDGE_CALLBACK_SECRET: 'secret',
    };

    const config = buildBridgeConfig(new ConfigService(), '/workspace/app', '/home/tester');

    expect(config.host).toBe('0.0.0.0');
    expect(config.apiToken).toBe('token');
    expect(config.callbackSecret).toBe('secret');
  });

  it('rejects partial OpenClaw hook configuration', () => {
    process.env = {
      OPENCLAW_HOOKS_URL: 'http://127.0.0.1:3994/hooks',
    };

    expect(() => buildBridgeConfig(new ConfigService(), '/workspace/app')).toThrow(
      'OPENCLAW_HOOKS_TOKEN is required when OPENCLAW_HOOKS_URL is set',
    );
  });

  it('accepts complete OpenClaw hook configuration', () => {
    process.env = {
      OPENCLAW_HOOKS_URL: 'http://127.0.0.1:3994/hooks',
      OPENCLAW_HOOKS_TOKEN: 'token',
      OPENCLAW_HOOKS_SESSION_KEY: 'agent:main:telegram:direct',
    };

    const config = buildBridgeConfig(new ConfigService(), '/workspace/app', '/home/tester');

    expect(config.openclawHooks).toEqual({
      url: 'http://127.0.0.1:3994/hooks',
      token: 'token',
      sessionKey: 'agent:main:telegram:direct',
    });
  });
});
