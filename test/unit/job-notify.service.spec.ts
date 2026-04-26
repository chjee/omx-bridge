import { createHmac } from 'node:crypto';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobNotifyService } from '../../src/jobs/job-notify.service';
import type { BridgeJob } from '../../src/jobs/job.types';

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
    sigkillGraceMs: 5000,
    notifyMode: 'claude',
    telegram: {
      botToken: 'token',
      chatId: 'chat',
    },
    ...overrides,
  };
}

const TELEGRAM_URL = 'https://api.telegram.org/bottoken/sendMessage';
const CLAUDE_URL = 'http://127.0.0.1:3993/notify';
const OPENCLAW_URL = 'http://openclaw.local/hooks/notify';

describe('JobNotifyService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends claude webhook payload with id and callback signature without telegram fallback on success', async () => {
    const config = createConfig({
      callbackSecret: 'secret',
      claudeNotifyUrl: CLAUDE_URL,
    });
    const service = new JobNotifyService(config);
    const job = createJob({ stdout: 'x'.repeat(2100), stderr: 'e'.repeat(600) });

    await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CLAUDE_URL);

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

  it('sends telegram fallback in claude mode when notifyUrl is missing', async () => {
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: undefined }));

    await service.notifyJobComplete(createJob());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(TELEGRAM_URL);
  });

  it('sends telegram fallback in claude mode when webhook returns a non-ok response', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === CLAUDE_URL) {
        return Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' });
      }
      return Promise.resolve({ ok: true });
    });
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: CLAUDE_URL }));

    await service.notifyJobComplete(createJob());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls[0]).toBe(CLAUDE_URL);
    expect(urls[1]).toBe(TELEGRAM_URL);
  });

  it('sends telegram fallback in claude mode when webhook fetch throws', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === CLAUDE_URL) {
        return Promise.reject(new Error('connection refused'));
      }
      return Promise.resolve({ ok: true });
    });
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: CLAUDE_URL }));

    await service.notifyJobComplete(createJob());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls[0]).toBe(CLAUDE_URL);
    expect(urls[1]).toBe(TELEGRAM_URL);
  });

  it('sends both OpenClaw hooks and Telegram notifications in openclaw mode', async () => {
    const service = new JobNotifyService(createConfig({
      notifyMode: 'openclaw',
      openclawHooks: {
        url: OPENCLAW_URL,
        token: 'openclaw-token',
        sessionKey: 'session-key',
      },
    }));

    await service.notifyJobComplete(createJob());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls).toContain(OPENCLAW_URL);
    expect(urls).toContain(TELEGRAM_URL);
  });
});
