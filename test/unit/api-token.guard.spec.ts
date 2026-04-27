import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { ApiTokenGuard } from '../../src/jobs/api-token.guard';

function createConfig(apiToken: string | undefined): BridgeConfig {
  return {
    jobsDirectory: '/tmp/jobs',
    omxCommand: 'omx',
    jobPollIntervalMs: 100,
    jobTimeoutMs: 1000,
    maxOutputChars: 1000,
    sigkillGraceMs: 5000,
    maxConcurrency: 1,
    maxActiveJobs: 50,
    jobRetentionDays: 7,
    maxTerminalJobs: 1000,
    jobCleanupIntervalMs: 3600000,
    notifyMode: 'openclaw',
    apiToken,
  };
}

function createContext(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('ApiTokenGuard', () => {
  it('allows when apiToken is unset (default-allow)', () => {
    const guard = new ApiTokenGuard(createConfig(undefined));
    expect(guard.canActivate(createContext({}))).toBe(true);
  });

  it('allows when correct Bearer token is provided', () => {
    const guard = new ApiTokenGuard(createConfig('secret-token'));
    expect(
      guard.canActivate(createContext({ authorization: 'Bearer secret-token' })),
    ).toBe(true);
  });

  it('rejects when Authorization header is missing', () => {
    const guard = new ApiTokenGuard(createConfig('secret-token'));
    expect(() => guard.canActivate(createContext({}))).toThrow(UnauthorizedException);
  });

  it('rejects when Authorization scheme is not Bearer', () => {
    const guard = new ApiTokenGuard(createConfig('secret-token'));
    expect(() =>
      guard.canActivate(createContext({ authorization: 'Basic c2VjcmV0' })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects when token differs', () => {
    const guard = new ApiTokenGuard(createConfig('secret-token'));
    expect(() =>
      guard.canActivate(createContext({ authorization: 'Bearer wrong-token' })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects token of different length without throwing on timingSafeEqual', () => {
    const guard = new ApiTokenGuard(createConfig('secret-token'));
    expect(() =>
      guard.canActivate(createContext({ authorization: 'Bearer short' })),
    ).toThrow(UnauthorizedException);
  });
});
