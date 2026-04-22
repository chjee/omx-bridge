import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { TelegramNotifyService } from '../../src/jobs/telegram-notify.service';
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

describe('TelegramNotifyService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCurlSuccess();
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends claude webhook payload with id and callback signature', async () => {
    const config = createConfig({
      callbackSecret: 'secret',
      claudeNotifyUrl: 'http://127.0.0.1:3993/notify',
    });
    const service = new TelegramNotifyService(config);
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
  });

  it('sends telegram fallback in claude mode even when notifyUrl is missing', async () => {
    const service = new TelegramNotifyService(createConfig({ claudeNotifyUrl: undefined }));

    await service.notifyJobComplete(createJob());

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0]?.[0]).toBe('curl');
    expect(mockSpawn.mock.calls[0]?.[1]).toContain('https://api.telegram.org/bottoken/sendMessage');
  });
});
