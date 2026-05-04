import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobNotifyService } from '../../src/jobs/job-notify.service';
import type { JobQueueRepository } from '../../src/jobs/job-queue.repository';
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
    source: overrides.source,
    sourceName: overrides.sourceName,
    originRoutingKey: overrides.originRoutingKey,
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
    host: '127.0.0.1',
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
    notifyRetryDelaysMs: [],
    notifyTimeoutMs: 5000,
    notifyMode: 'claude',
    allowedCwdPrefixes: ['/workspace'],
    telegram: {
      botToken: 'token',
      chatId: 'chat',
    },
    ...overrides,
  };
}

function createRepoMock(initialJob: BridgeJob): {
  repo: JobQueueRepository;
  getById: jest.Mock;
  save: jest.Mock;
  current: BridgeJob;
} {
  const state = { current: initialJob };
  const getById = jest.fn(async (id: string) =>
    id === state.current.id ? state.current : null,
  );
  const save = jest.fn(async (job: BridgeJob) => {
    state.current = job;
    return job;
  });
  return {
    repo: { getById, save } as unknown as JobQueueRepository,
    getById,
    save,
    get current() {
      return state.current;
    },
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

  it('sends claude webhook payload with id and callback signature, skipping telegram on webhook ok', async () => {
    const config = createConfig({
      callbackSecret: 'secret',
      claudeNotifyUrl: CLAUDE_URL,
    });
    const job = createJob({ stdout: 'x'.repeat(2100), stderr: 'e'.repeat(600) });
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(config, repoMock.repo);

    const outcome = await service.notifyJobComplete(job);

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

    expect(outcome.mode).toBe('claude');
    expect(outcome.claudeWebhook).toEqual({ status: 'ok', attempts: 1 });
    expect(outcome.telegram).toEqual({ status: 'skipped', skippedReason: 'webhook_ok' });
    expect(repoMock.save).toHaveBeenCalledTimes(1);
    expect(repoMock.current.notifyOutcome).toEqual(outcome);
  });

  it('persists notify outcomes into notifyHistory with sequential attempt indexes', async () => {
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(
      createConfig({ notifyMode: 'openclaw', telegram: undefined }),
      repoMock.repo,
    );

    const firstOutcome = await service.notifyJobComplete(job);
    const secondOutcome = await service.notifyJobComplete(repoMock.current);

    expect(repoMock.current.notifyHistory).toHaveLength(2);
    expect(repoMock.current.notifyHistory?.map((entry) => entry.attemptIndex)).toEqual([0, 1]);
    expect(repoMock.current.notifyHistory?.[0]).toEqual(firstOutcome);
    expect(repoMock.current.notifyHistory?.[1]).toEqual(secondOutcome);
    expect(repoMock.current.notifyOutcome).toEqual(secondOutcome);
  });

  it('serializes concurrent notify outcome persistence for the same job', async () => {
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(
      createConfig({ notifyMode: 'openclaw', telegram: undefined }),
      repoMock.repo,
    );

    const [autoOutcome, manualOutcome] = await Promise.all([
      service.notifyJobComplete(job),
      service.notifyJobComplete(job, { trigger: 'manual' }),
    ]);

    expect(repoMock.current.notifyHistory).toHaveLength(2);
    expect(repoMock.current.notifyHistory?.map((entry) => entry.attemptIndex)).toEqual([0, 1]);
    expect(repoMock.current.notifyHistory?.map((entry) => entry.trigger)).toEqual(['auto', 'manual']);
    expect(repoMock.current.notifyHistory).toEqual([autoOutcome, manualOutcome]);
    expect(repoMock.current.notifyOutcome).toEqual(manualOutcome);
  });

  it('marks manually triggered notify outcomes', async () => {
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(
      createConfig({ notifyMode: 'openclaw', telegram: undefined }),
      repoMock.repo,
    );

    const outcome = await service.notifyJobComplete(job, { trigger: 'manual' });

    expect(outcome.trigger).toBe('manual');
    expect(repoMock.current.notifyHistory).toEqual([outcome]);
    expect(repoMock.current.notifyOutcome).toEqual(outcome);
  });

  it('sends telegram fallback in claude mode when notifyUrl is missing', async () => {
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: undefined }), repoMock.repo);

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(TELEGRAM_URL);
    expect(outcome.claudeWebhook).toEqual({ status: 'skipped', skippedReason: 'no_notify_url' });
    expect(outcome.telegram).toEqual({ status: 'ok' });
  });

  it('sends telegram fallback in claude mode when webhook returns a non-ok response', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === CLAUDE_URL) {
        return Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' });
      }
      return Promise.resolve({ ok: true });
    });
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: CLAUDE_URL }), repoMock.repo);

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls[0]).toBe(CLAUDE_URL);
    expect(urls[1]).toBe(TELEGRAM_URL);
    expect(outcome.claudeWebhook).toMatchObject({
      status: 'failed',
      error: 'http_500',
      httpStatus: 500,
      attempts: 1,
    });
    expect(outcome.telegram).toEqual({ status: 'ok' });
    expect(repoMock.current.notifyOutcome).toEqual(outcome);
  });

  it('sends telegram fallback in claude mode when webhook fetch throws', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === CLAUDE_URL) {
        return Promise.reject(new Error('connection refused'));
      }
      return Promise.resolve({ ok: true });
    });
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: CLAUDE_URL }), repoMock.repo);

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls[0]).toBe(CLAUDE_URL);
    expect(urls[1]).toBe(TELEGRAM_URL);
    expect(outcome.claudeWebhook).toEqual({ status: 'failed', error: 'fetch_error', attempts: 1 });
    expect(outcome.telegram).toEqual({ status: 'ok' });
  });

  it('retries claude webhook before falling back', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
      .mockResolvedValueOnce({ ok: true });
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(
      createConfig({ claudeNotifyUrl: CLAUDE_URL, notifyRetryDelaysMs: [1, 1] }),
      repoMock.repo,
    );

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([CLAUDE_URL, CLAUDE_URL, CLAUDE_URL]);
    expect(outcome.claudeWebhook).toEqual({ status: 'ok', attempts: 3 });
    expect(outcome.telegram).toEqual({ status: 'skipped', skippedReason: 'webhook_ok' });
  });

  it('records timeout errors when claude webhook exceeds notify timeout', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== CLAUDE_URL) {
        return Promise.resolve({ ok: true });
      }

      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      });
    });
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(
      createConfig({
        claudeNotifyUrl: CLAUDE_URL,
        notifyRetryDelaysMs: [],
        notifyTimeoutMs: 1,
      }),
      repoMock.repo,
    );

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.claudeWebhook).toEqual({ status: 'failed', error: 'timeout', attempts: 1 });
    expect(outcome.telegram).toEqual({ status: 'ok' });
  });

  it('does not log Telegram bot tokens when sendMessage throws', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const botToken = '123456:super-secret-token';
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(botToken)) {
        return Promise.reject(new Error(`request failed for ${url}`));
      }
      return Promise.resolve({ ok: true });
    });
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(
      createConfig({ claudeNotifyUrl: undefined, telegram: { botToken, chatId: 'chat' } }),
      repoMock.repo,
    );

    await service.notifyJobComplete(job);

    const logged = warnSpy.mock.calls.flat().join('\n');
    expect(logged).not.toContain(botToken);
    expect(logged).toContain('<redacted>');
    warnSpy.mockRestore();
  });

  it('skips telegram fallback for per-job notifyUrl callers in claude mode', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway' });
    const job = createJob({ source: 'dispatch', notifyUrl: CLAUDE_URL });
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(createConfig(), repoMock.repo);

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CLAUDE_URL);
    expect(outcome.claudeWebhook).toMatchObject({ status: 'failed', httpStatus: 502, attempts: 1 });
    expect(outcome.telegram).toEqual({ status: 'skipped', skippedReason: 'per_job_webhook_failed' });
  });

  it('skips telegram fallback for synapse-broker callers in claude mode', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === CLAUDE_URL) {
        return Promise.resolve({ ok: false, status: 502, statusText: 'Bad Gateway' });
      }
      return Promise.resolve({ ok: true });
    });
    const job = createJob({ source: 'synapse', originRoutingKey: 'telegram:direct:123' });
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: CLAUDE_URL }), repoMock.repo);

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CLAUDE_URL);
    expect(outcome.claudeWebhook).toMatchObject({ status: 'failed', httpStatus: 502, attempts: 1 });
    expect(outcome.telegram).toEqual({ status: 'skipped', skippedReason: 'broker_fallback' });
  });

  it('skips telegram fallback for channel-broker callers in claude mode', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === CLAUDE_URL) {
        return Promise.resolve({ ok: false, status: 502, statusText: 'Bad Gateway' });
      }
      return Promise.resolve({ ok: true });
    });
    const job = createJob({
      source: 'channel',
      sourceName: 'claude-chopper',
      originRoutingKey: 'telegram:group:-100123',
    });
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: CLAUDE_URL }), repoMock.repo);

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CLAUDE_URL);
    expect(outcome.claudeWebhook).toMatchObject({ status: 'failed', httpStatus: 502, attempts: 1 });
    expect(outcome.telegram).toEqual({ status: 'skipped', skippedReason: 'broker_fallback' });
  });

  it('uses telegram fallback for openclaw callers with originRoutingKey but no per-job notifyUrl', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === CLAUDE_URL) {
        return Promise.resolve({ ok: false, status: 502, statusText: 'Bad Gateway' });
      }
      return Promise.resolve({ ok: true });
    });
    const job = createJob({
      source: 'openclaw',
      sourceName: 'openclaw-telegram',
      originRoutingKey: 'telegram:direct:123',
    });
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(createConfig({ claudeNotifyUrl: CLAUDE_URL }), repoMock.repo);

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CLAUDE_URL);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(TELEGRAM_URL);
    expect(outcome.claudeWebhook).toMatchObject({ status: 'failed', httpStatus: 502, attempts: 1 });
    expect(outcome.telegram).toEqual({ status: 'ok' });
  });

  it('skips telegram fallback for openclaw callers when per-job notifyUrl owns callback delivery', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway' });
    const job = createJob({
      source: 'openclaw',
      sourceName: 'openclaw-telegram',
      originRoutingKey: 'telegram:direct:123',
      notifyUrl: CLAUDE_URL,
    });
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(createConfig(), repoMock.repo);

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CLAUDE_URL);
    expect(outcome.claudeWebhook).toMatchObject({ status: 'failed', httpStatus: 502, attempts: 1 });
    expect(outcome.telegram).toEqual({ status: 'skipped', skippedReason: 'per_job_webhook_failed' });
  });

  it('sends both OpenClaw hooks and Telegram notifications in openclaw mode', async () => {
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(
      createConfig({
        notifyMode: 'openclaw',
        openclawHooks: {
          url: OPENCLAW_URL,
          token: 'openclaw-token',
          sessionKey: 'session-key',
        },
      }),
      repoMock.repo,
    );

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls).toContain(OPENCLAW_URL);
    expect(urls).toContain(TELEGRAM_URL);
    expect(outcome.mode).toBe('openclaw');
    expect(outcome.openclaw).toEqual({ status: 'ok' });
    expect(outcome.telegram).toEqual({ status: 'ok' });
  });

  it('records skipped channels when neither openclaw nor telegram is configured', async () => {
    const job = createJob();
    const repoMock = createRepoMock(job);
    const service = new JobNotifyService(
      createConfig({ notifyMode: 'openclaw', telegram: undefined }),
      repoMock.repo,
    );

    const outcome = await service.notifyJobComplete(job);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.openclaw).toEqual({ status: 'skipped', skippedReason: 'not_configured' });
    expect(outcome.telegram).toEqual({ status: 'skipped', skippedReason: 'not_configured' });
    expect(repoMock.current.notifyOutcome).toEqual(outcome);
  });
});
