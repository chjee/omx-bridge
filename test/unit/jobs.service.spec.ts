import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import path from 'node:path';
import type { BridgeConfig } from '../../src/config/bridge-config';
import type { JobCallbackDto } from '../../src/jobs/dto/job-callback.dto';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import { JobNotifyService } from '../../src/jobs/job-notify.service';
import { JobRunnerService } from '../../src/jobs/job-runner.service';
import { JobsService } from '../../src/jobs/jobs.service';
import type { BridgeJob } from '../../src/jobs/job.types';

const TEST_ID = '00000000-0000-4000-a000-000000000001';

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? TEST_ID,
    prompt: overrides.prompt ?? 'hello',
    queueOrder: overrides.queueOrder ?? '0000000000001-000001',
    status: overrides.status ?? 'queued',
    createdAt: overrides.createdAt ?? '2026-04-23T00:00:00.000Z',
    exitCode: overrides.exitCode ?? null,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    execution: overrides.execution ?? {
      command: 'omx',
      timeoutMs: 900_000,
      maxOutputChars: 32_000,
    },
    ...overrides,
  };
}

function createConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    host: '127.0.0.1',
    jobsDirectory: '/tmp/jobs',
    omxCommand: 'omx',
    jobPollIntervalMs: 100,
    jobTimeoutMs: 900_000,
    maxOutputChars: 32_000,
    sigkillGraceMs: 5000,
    maxConcurrency: 1,
    maxActiveJobs: 50,
    jobRetentionDays: 7,
    maxTerminalJobs: 1000,
    jobCleanupIntervalMs: 3600000,
    notifyTimeoutMs: 5000,
    notifyMode: 'claude',
    allowedCwdPrefixes: ['/workspace', '/home/tester'],
    ...overrides,
  };
}

function createService(
  jobs: Map<string, BridgeJob> = new Map(),
  configOverrides: Partial<BridgeConfig> = {},
) {
  const repository = {
    create: jest.fn(async (job: BridgeJob) => { jobs.set(job.id, job); return job; }),
    save: jest.fn(async (job: BridgeJob) => { jobs.set(job.id, job); return job; }),
    getById: jest.fn(async (id: string) => jobs.get(id) ?? null),
    listAll: jest.fn(async () => [...jobs.values()]),
    listByStatus: jest.fn(async (status: string) => [...jobs.values()].filter((j) => j.status === status)),
    countActive: jest.fn(async () =>
      [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').length,
    ),
  } as unknown as JobQueueRepository;

  const jobRunnerService = {
    cancel: jest.fn().mockResolvedValue(true),
    trigger: jest.fn(),
  } as unknown as JobRunnerService;

  const jobNotify = {
    notifyJobComplete: jest.fn().mockResolvedValue(undefined),
  } as unknown as JobNotifyService;

  const service = new JobsService(repository, jobRunnerService, jobNotify, createConfig(configOverrides));
  return { service, repository, jobRunnerService, jobNotify };
}

describe('JobsService.createJob', () => {
  it('triggers the runner after a queued job is persisted', async () => {
    const { service, repository, jobRunnerService } = createService();

    const job = await service.createJob({ prompt: 'run soon' });

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      id: job.id,
      prompt: 'run soon',
      status: 'queued',
    }));
    expect(jobRunnerService.trigger).toHaveBeenCalledTimes(1);
  });

  it('stores a request fingerprint when requestId is provided', async () => {
    const { service, repository } = createService();

    const job = await service.createJob({
      prompt: 'fingerprinted',
      requestId: 'req-fingerprint',
      source: 'dispatch',
      metadata: { nested: { b: 2, a: 1 } },
    });

    expect(job.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-fingerprint',
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it('preserves channel sourceName on queued jobs', async () => {
    const { service, repository } = createService();

    const job = await service.createJob({
      prompt: 'run from channel',
      source: 'channel',
      sourceName: 'claude-chopper',
      originRoutingKey: 'telegram:group:-100123',
    });

    expect(job.source).toBe('channel');
    expect(job.sourceName).toBe('claude-chopper');
    expect(job.originRoutingKey).toBe('telegram:group:-100123');
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      source: 'channel',
      sourceName: 'claude-chopper',
      originRoutingKey: 'telegram:group:-100123',
    }));
  });

  it('returns an existing job for repeated source-scoped requestId submissions', async () => {
    const existingJob = createJob({
      prompt: 'same request retry',
      requestId: 'req-1',
      source: 'dispatch',
      status: 'running',
    });
    const jobs = new Map([[existingJob.id, existingJob]]);
    const { service, repository, jobRunnerService } = createService(jobs);

    const result = await service.createJob({
      prompt: 'same request retry',
      requestId: 'req-1',
      source: 'dispatch',
    });

    expect(result).toBe(existingJob);
    expect(repository.save).not.toHaveBeenCalled();
    expect(jobRunnerService.trigger).not.toHaveBeenCalled();
  });

  it('treats metadata key order as the same request fingerprint', async () => {
    const jobs = new Map<string, BridgeJob>();
    const { service, repository, jobRunnerService } = createService(jobs);

    const first = await service.createJob({
      prompt: 'same metadata',
      requestId: 'req-stable',
      source: 'dispatch',
      metadata: { b: 2, a: { y: true, x: false } },
    });
    const second = await service.createJob({
      prompt: 'same metadata',
      requestId: 'req-stable',
      source: 'dispatch',
      metadata: { a: { x: false, y: true }, b: 2 },
    });

    expect(second).toBe(first);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(jobRunnerService.trigger).toHaveBeenCalledTimes(1);
  });

  it('rejects repeated source-scoped requestId submissions with a different payload', async () => {
    const jobs = new Map<string, BridgeJob>();
    const { service, repository, jobRunnerService } = createService(jobs);
    await service.createJob({
      prompt: 'original prompt',
      requestId: 'req-conflict',
      source: 'dispatch',
      notifyUrl: 'http://127.0.0.1:12000/notify',
    });

    await expect(service.createJob({
      prompt: 'changed prompt',
      requestId: 'req-conflict',
      source: 'dispatch',
      notifyUrl: 'http://127.0.0.1:12000/notify',
    })).rejects.toThrow(ConflictException);

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(jobRunnerService.trigger).toHaveBeenCalledTimes(1);
  });

  it('treats the same requestId from a different source as a new job', async () => {
    const existingJob = createJob({
      requestId: 'req-1',
      source: 'dispatch',
      status: 'running',
    });
    const jobs = new Map([[existingJob.id, existingJob]]);
    const { service, repository, jobRunnerService } = createService(jobs);

    const result = await service.createJob({
      prompt: 'channel request',
      requestId: 'req-1',
      source: 'channel',
    });

    expect(result.id).not.toBe(existingJob.id);
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-1',
      source: 'channel',
      status: 'queued',
    }));
    expect(jobRunnerService.trigger).toHaveBeenCalledTimes(1);
  });

  it('rejects new jobs when active job capacity is full', async () => {
    const activeJob = createJob({ status: 'queued' });
    const jobs = new Map([[activeJob.id, activeJob]]);
    const { service, repository, jobRunnerService } = createService(jobs, { maxActiveJobs: 1 });

    await expect(service.createJob({ prompt: 'overflow' })).rejects.toThrow(HttpException);
    expect(repository.save).not.toHaveBeenCalled();
    expect(jobRunnerService.trigger).not.toHaveBeenCalled();
  });

  it('accepts cwd values inside an allowed prefix', async () => {
    const { service, repository } = createService(new Map(), {
      allowedCwdPrefixes: [path.resolve('/workspace')],
    });

    const job = await service.createJob({ prompt: 'inside', cwd: '/workspace/project' });

    expect(job.cwd).toBe('/workspace/project');
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('rejects cwd values outside allowed prefixes', async () => {
    const { service, repository, jobRunnerService } = createService(new Map(), {
      allowedCwdPrefixes: [path.resolve('/workspace')],
    });

    await expect(service.createJob({ prompt: 'outside', cwd: '/etc' })).rejects.toThrow(
      HttpException,
    );
    expect(repository.save).not.toHaveBeenCalled();
    expect(jobRunnerService.trigger).not.toHaveBeenCalled();
  });
});

describe('JobsService.cancelJob', () => {
  it('marks a queued job cancelled and sends completion notification', async () => {
    const job = createJob({ status: 'queued' });
    const jobs = new Map([[job.id, job]]);
    const { service, jobNotify, jobRunnerService } = createService(jobs);

    const result = await service.cancelJob(job.id);

    expect(result.status).toBe('cancelled');
    expect(result.stderr).toBe('Cancelled by API request');
    expect(jobRunnerService.cancel).toHaveBeenCalledWith(job.id);
    expect(jobNotify.notifyJobComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id, status: 'cancelled' }),
    );
  });

  it('returns an already cancelled job without sending another notification', async () => {
    const job = createJob({ status: 'cancelled' });
    const jobs = new Map([[job.id, job]]);
    const { service, jobNotify, jobRunnerService } = createService(jobs);

    const result = await service.cancelJob(job.id);

    expect(result).toBe(job);
    expect(jobRunnerService.cancel).not.toHaveBeenCalled();
    expect(jobNotify.notifyJobComplete).not.toHaveBeenCalled();
  });

  it('rejects cancelling a non-cancelled terminal job', async () => {
    const job = createJob({ status: 'succeeded' });
    const jobs = new Map([[job.id, job]]);
    const { service, jobNotify } = createService(jobs);

    await expect(service.cancelJob(job.id)).rejects.toThrow(ConflictException);
    expect(jobNotify.notifyJobComplete).not.toHaveBeenCalled();
  });
});

describe('JobsService.completeJobFromCallback', () => {
  it('applies allowed execution fields from callback', async () => {
    const job = createJob({ status: 'running' });
    const jobs = new Map([[job.id, job]]);
    const { service, repository } = createService(jobs);

    const callback: JobCallbackDto = {
      status: 'succeeded',
      stdout: 'ok',
      exitCode: 0,
      execution: { durationMs: 1234, timedOut: false, outputTruncated: true, errorType: undefined },
    };

    const result = await service.completeJobFromCallback(job.id, callback);

    expect(result.execution.durationMs).toBe(1234);
    expect(result.execution.timedOut).toBe(false);
    expect(result.execution.outputTruncated).toBe(true);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('does not allow callback to overwrite server-owned execution fields', async () => {
    const job = createJob({
      status: 'running',
      execution: { command: 'omx', timeoutMs: 900_000, maxOutputChars: 32_000 },
    });
    const jobs = new Map([[job.id, job]]);
    const { service } = createService(jobs);

    const maliciousCallback: JobCallbackDto = {
      status: 'succeeded',
      execution: {
        // @ts-expect-error — intentionally passing disallowed fields to verify runtime protection
        command: 'injected',
        timeoutMs: 1,
        maxOutputChars: 1,
        durationMs: 500,
      },
    };

    const result = await service.completeJobFromCallback(job.id, maliciousCallback);

    expect(result.execution.command).toBe('omx');
    expect(result.execution.timeoutMs).toBe(900_000);
    expect(result.execution.maxOutputChars).toBe(32_000);
    expect(result.execution.durationMs).toBe(500);
  });

  it('handles missing execution field gracefully', async () => {
    const job = createJob({ status: 'running' });
    const jobs = new Map([[job.id, job]]);
    const { service } = createService(jobs);

    const result = await service.completeJobFromCallback(job.id, { status: 'succeeded' });

    expect(result.execution.command).toBe('omx');
    expect(result.execution.durationMs).toBeUndefined();
  });

  it('throws NotFoundException for unknown job id', async () => {
    const { service } = createService();
    await expect(
      service.completeJobFromCallback('00000000-0000-4000-a000-000000000099', { status: 'succeeded' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns the existing terminal job idempotently without modification', async () => {
    const job = createJob({ status: 'succeeded', stdout: 'original' });
    const jobs = new Map([[job.id, job]]);
    const { service, jobNotify } = createService(jobs);

    const result = await service.completeJobFromCallback(job.id, {
      status: 'failed',
      stdout: 'should-not-overwrite',
    });

    expect(result.status).toBe('succeeded');
    expect(result.stdout).toBe('original');
    expect(jobNotify.notifyJobComplete).not.toHaveBeenCalled();
  });

  it('fires notifyJobComplete after saving', async () => {
    const job = createJob({ status: 'running' });
    const jobs = new Map([[job.id, job]]);
    const { service, jobNotify } = createService(jobs);

    await service.completeJobFromCallback(job.id, { status: 'succeeded' });

    expect(jobNotify.notifyJobComplete).toHaveBeenCalledTimes(1);
    expect(jobNotify.notifyJobComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id, status: 'succeeded' }),
    );
  });
});

describe('JobsService.getStats', () => {
  it('returns zero counts and null oldestQueuedAgeMs for an empty queue', async () => {
    const { service, repository } = createService(
      new Map(),
      { maxActiveJobs: 12, maxConcurrency: 3 },
    );

    const stats = await service.getStats();

    expect(repository.listAll).toHaveBeenCalledTimes(1);
    expect(stats).toEqual({
      queuedCount: 0,
      runningCount: 0,
      activeCount: 0,
      terminalCount: 0,
      maxActiveJobs: 12,
      maxConcurrency: 3,
      oldestQueuedAgeMs: null,
    });
  });

  it('counts queued jobs as active and reports an oldest queued age', async () => {
    const queuedJob = createJob({
      status: 'queued',
      createdAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const jobs = new Map([[queuedJob.id, queuedJob]]);
    const { service } = createService(jobs);

    const stats = await service.getStats();

    expect(stats.queuedCount).toBe(1);
    expect(stats.runningCount).toBe(0);
    expect(stats.activeCount).toBe(1);
    expect(stats.terminalCount).toBe(0);
    expect(stats.oldestQueuedAgeMs).not.toBeNull();
    expect(stats.oldestQueuedAgeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('JobsService.triggerNotifyRetry', () => {
  it('manually retries notify for terminal jobs and returns the latest persisted job', async () => {
    const job = createJob({ status: 'succeeded' });
    const updatedJob = createJob({
      status: 'succeeded',
      notifyHistory: [
        {
          attemptedAt: '2026-04-23T00:00:01.000Z',
          mode: 'claude',
          trigger: 'manual',
          attemptIndex: 0,
        },
      ],
    });
    const jobs = new Map([[job.id, job]]);
    const { service, repository, jobNotify } = createService(jobs);
    (jobNotify.notifyJobComplete as jest.Mock).mockImplementation(async () => {
      await repository.save(updatedJob);
    });

    const result = await service.triggerNotifyRetry(job.id);

    expect(jobNotify.notifyJobComplete).toHaveBeenCalledWith(job, { trigger: 'manual' });
    expect(result).toEqual(updatedJob);
  });

  it('rejects manual notify retry for non-terminal jobs', async () => {
    const job = createJob({ status: 'queued' });
    const jobs = new Map([[job.id, job]]);
    const { service, jobNotify } = createService(jobs);

    await expect(service.triggerNotifyRetry(job.id)).rejects.toThrow(ConflictException);
    expect(jobNotify.notifyJobComplete).not.toHaveBeenCalled();
  });
});
