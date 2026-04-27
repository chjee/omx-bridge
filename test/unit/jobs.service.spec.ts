import { ConflictException, NotFoundException } from '@nestjs/common';
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
    jobsDirectory: '/tmp/jobs',
    omxCommand: 'omx',
    jobPollIntervalMs: 100,
    jobTimeoutMs: 900_000,
    maxOutputChars: 32_000,
    sigkillGraceMs: 5000,
    maxConcurrency: 1,
    notifyMode: 'claude',
    ...overrides,
  };
}

function createService(jobs: Map<string, BridgeJob> = new Map()) {
  const repository = {
    create: jest.fn(async (job: BridgeJob) => { jobs.set(job.id, job); return job; }),
    save: jest.fn(async (job: BridgeJob) => { jobs.set(job.id, job); return job; }),
    getById: jest.fn(async (id: string) => jobs.get(id) ?? null),
    listAll: jest.fn(async () => [...jobs.values()]),
    listByStatus: jest.fn(async (status: string) => [...jobs.values()].filter((j) => j.status === status)),
  } as unknown as JobQueueRepository;

  const jobRunnerService = {
    cancel: jest.fn().mockResolvedValue(true),
  } as unknown as JobRunnerService;

  const jobNotify = {
    notifyJobComplete: jest.fn().mockResolvedValue(undefined),
  } as unknown as JobNotifyService;

  const service = new JobsService(repository, jobRunnerService, jobNotify, createConfig());
  return { service, repository, jobRunnerService, jobNotify };
}

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
