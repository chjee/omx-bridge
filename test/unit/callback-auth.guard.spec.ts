import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { CallbackAuthGuard } from '../../src/jobs/callback-auth.guard';

function createConfig(callbackSecret: string | undefined = 'secret'): BridgeConfig {
  return {
    jobsDirectory: '/tmp/jobs',
    omxCommand: 'omx',
    jobPollIntervalMs: 100,
    jobTimeoutMs: 1000,
    maxOutputChars: 1000,
    notifyMode: 'openclaw',
    callbackSecret,
  };
}

function createContext(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

function signatureFor(jobId: string, body: string): string {
  return `sha256=${createHmac('sha256', 'secret').update(`${jobId}:${body}`).digest('hex')}`;
}

describe('CallbackAuthGuard', () => {
  it('verifies callback signatures against raw request body bytes', () => {
    const jobId = '00000000-0000-4000-a000-000000000001';
    const rawBody = '{\n  "status": "succeeded",\n  "stdout": "ok",\n  "exitCode": 0\n}';
    const guard = new CallbackAuthGuard(createConfig());

    expect(
      guard.canActivate(
        createContext({
          params: { id: jobId },
          headers: { 'x-callback-signature': signatureFor(jobId, rawBody) },
          body: { exitCode: 0, stdout: 'ok', status: 'succeeded' },
          rawBody: Buffer.from(rawBody, 'utf8'),
        }),
      ),
    ).toBe(true);
  });

  it('rejects signatures computed from a reserialized parsed body', () => {
    const jobId = '00000000-0000-4000-a000-000000000001';
    const rawBody = '{\n  "status": "succeeded",\n  "stdout": "ok",\n  "exitCode": 0\n}';
    const parsedBody = { exitCode: 0, stdout: 'ok', status: 'succeeded' };
    const guard = new CallbackAuthGuard(createConfig());

    expect(() =>
      guard.canActivate(
        createContext({
          params: { id: jobId },
          headers: { 'x-callback-signature': signatureFor(jobId, JSON.stringify(parsedBody)) },
          body: parsedBody,
          rawBody: Buffer.from(rawBody, 'utf8'),
        }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('allows callbacks without a configured callback secret', () => {
    const guard = new CallbackAuthGuard({ ...createConfig(), callbackSecret: undefined });

    expect(
      guard.canActivate(
        createContext({
          params: { id: 'job-id' },
          headers: {},
        }),
      ),
    ).toBe(true);
  });
});
