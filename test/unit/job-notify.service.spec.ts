import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobNotifyService } from '../../src/jobs/job-notify.service';
import type { BridgeJob } from '../../src/jobs/job.types';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? '00000000-0000-4000-a000-000000000001',
    prompt: overrides.prompt ?? 'run tests',
    cwd: overrides.cwd ?? '/workspace/app',
    queueOrder: overrides.queueOrder ?? '0000000000001-000001',
    requestId: overrides.requestId,
    metadata: overrides.metadata,
    notifyUrl: overrides.notifyUrl,
    status: overrides.status ?? 'succeeded',
    createdAt: overrides.createdAt ?? '2026-04-22T00:00:00.000Z',
    startedAt: overrides.startedAt ?? '2026-04-22T00:00:01.000Z',
    finishedAt: overrides.finishedAt ?? '2026-04-22T00:00:02.000Z',
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? 'done',
    stderr: overrides.stderr ?? '',
    execution: overrides.execution ?? {
      command: 'omx',
      timeoutMs: 1000,
      maxOutputChars: 1000,
      durationMs: 100,
    },
  };
}

function createConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    jobsDirectory: '/tmp/jobs',
    omxCommand: 'omx',
    jobPollIntervalMs: 100,
    jobTimeoutMs: 1000,
    maxOutputChars: 1000,
    notifyMode: 'claude',
    telegram: {
      botToken: 'token',
      chatId: 'chat',
    },
    ...overrides,
  };
}

function mockCurlSuccess(): void {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child as ReturnType<typeof spawn>;
  });
}

function expectTelegramFallback(): void {
  expect(mockSpawn).toHaveBeenCalledTimes(1);
  expect(mockSpawn.mock.calls[0]?.[0]).toBe('curl');
  expect(mockSpawn.mock.calls[0]?.[1]).toContain('https://api.telegram.org/bottoken/sendMessage');
}

describe('JobNotifyService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCurlSuccess();
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends claude webhook payload with id and callback signature without telegram fallback on success', async () => {
    const config = createConfig({
      callbackSecret: 'secret',
      claudeNotifyUrl: 'http://127.0.0.1:3993/notify',
    });
    const service = new JobNotifyService(config);
    const job = createJob({ stdout: 'x'.repeat(2100), stderr: 'e'.repeat(600) });

    await service.notifyJobComplete(job);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3993/notify');

    const body = String(init.body);
    const payload = JSON.parse(body) as BridgeJob;
    expect(payload.id).toBe(job.id);
    expect(payload).not.toHaveProperty('jobId');
    expect(payload.stdout).toHaveLength(2000);
    expect(payload.stderr).toHaveLength(500);

    const expectedSignature = `sha256=${createHmac('sha256', 'secret')
      .update(`${job.id}:${body}`)
      .digest('hex')}`;
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Callback-Signature': expectedSignature,
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('sends telegram fallback in claude mode when notifyUrl is missing', async () => {
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: undefined }));

    await service.notifyJobComplete(createJob());

    expect(global.fetch).not.toHaveBeenCalled();
    expectTelegramFallback();
  });

  it('sends telegram fallback in claude mode when webhook returns a non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }) as unknown as typeof fetch;
    const service = new JobNotifyService(createConfig({
      claudeNotifyUrl: 'http://127.0.0.1:3993/notify',
    }));

    await service.notifyJobComplete(createJob());

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expectTelegramFallback();
  });

  it('sends telegram fallback in claude mode when webhook fetch throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch;
    const service = new JobNotifyService(createConfig({
      claudeNotifyUrl: 'http://127.0.0.1:3993/notify',
    }));

    await service.notifyJobComplete(createJob());

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expectTelegramFallback();
  });

  it('sends both OpenClaw hooks and Telegram notifications in openclaw mode', async () => {
    const service = new JobNotifyService(createConfig({
      notifyMode: 'openclaw',
      openclawHooks: {
        url: 'http://openclaw.local/hooks/notify',
        token: 'openclaw-token',
        sessionKey: 'session-key',
      },
    }));

    await service.notifyJobComplete(createJob());

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const spawnedArgLists = mockSpawn.mock.calls.map(([, args]) => args ?? []);
    expect(spawnedArgLists.some((args) => args.includes('http://openclaw.local/hooks/notify'))).toBe(true);
    expect(spawnedArgLists.some((args) => args.includes('https://api.telegram.org/bottoken/sendMessage'))).toBe(true);
  });
});
