import { ConfigService } from '@nestjs/config';
import { buildBridgeConfig } from '../../src/config/bridge-config';

describe('buildBridgeConfig', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses documented defaults when env vars are unset', () => {
    process.env = {};

    const config = buildBridgeConfig(new ConfigService(), '/workspace/app');

    expect(config).toEqual({
      jobsDirectory: '/workspace/app/.omx/state/bridge-jobs',
      omxCommand: 'omx',
      jobPollIntervalMs: 500,
      jobTimeoutMs: 900000,
      maxOutputChars: 32000,
      sigkillGraceMs: 5000,
      notifyMode: 'openclaw',
      callbackSecret: undefined,
      apiToken: undefined,
      claudeNotifyUrl: undefined,
    });
  });

  it('uses env overrides when present', () => {
    process.env = {
      BRIDGE_JOBS_DIR: '/tmp/custom-jobs',
      OMX_COMMAND: 'omx-custom',
      BRIDGE_JOB_POLL_INTERVAL_MS: '250',
      BRIDGE_JOB_TIMEOUT_MS: '1234',
      BRIDGE_MAX_OUTPUT_CHARS: '999',
      BRIDGE_SIGKILL_GRACE_MS: '7500',
      BRIDGE_API_TOKEN: 'token-xyz',
    };

    const config = buildBridgeConfig(new ConfigService(), '/workspace/app');

    expect(config).toEqual({
      jobsDirectory: '/tmp/custom-jobs',
      omxCommand: 'omx-custom',
      jobPollIntervalMs: 250,
      jobTimeoutMs: 1234,
      maxOutputChars: 999,
      sigkillGraceMs: 7500,
      notifyMode: 'openclaw',
      callbackSecret: undefined,
      apiToken: 'token-xyz',
      claudeNotifyUrl: undefined,
    });
  });
});
