import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import { JobRunnerService } from '../../src/jobs/job-runner.service';
import type { BridgeJob, OmxExecutionResult } from '../../src/jobs/job.types';
import type { OmxExecService } from '../../src/jobs/omx-exec.service';
import type { JobNotifyService } from '../../src/jobs/job-notify.service';
import { createTempDir, waitFor } from '../helpers';

const mockJobNotify = {
  notifyJobComplete: jest.fn().mockResolvedValue(undefined),
} as unknown as JobNotifyService;

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? '00000000-0000-4000-a000-000000000001',
    prompt: overrides.prompt ?? 'hello',
    queueOrder: overrides.queueOrder ?? '0000000000001-000001',
    status: overrides.status ?? 'queued',
    createdAt: overrides.createdAt ?? '2026-04-02T00:00:00.000Z',
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt,
    exitCode: overrides.exitCode ?? null,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    metadata: overrides.metadata,
    requestId: overrides.requestId,
    execution: overrides.execution ?? {
      command: 'omx',
      timeoutMs: 1000,
      maxOutputChars: 1000,
    },
  };
}

function createExecutionResult(
  overrides: Partial<OmxExecutionResult> = {},
): OmxExecutionResult {
  return {
    status: overrides.status ?? 'succeeded',
    stdout: overrides.stdout ?? 'done',
    stderr: overrides.stderr ?? '',
    exitCode: overrides.exitCode ?? 0,
    execution: overrides.execution ?? {
      command: 'omx',
      timeoutMs: 1000,
      maxOutputChars: 1000,
    },
  };
}

describe('JobRunnerService', () => {
  let repository: JobQueueRepository;
  let config: BridgeConfig;

  beforeEach(async () => {
    config = {
      jobsDirectory: await createTempDir('runner-jobs'),
      omxCommand: 'omx',
      jobPollIntervalMs: 10,
      jobTimeoutMs: 1000,
      maxOutputChars: 1000,
      sigkillGraceMs: 5000,
      maxConcurrency: 1,
      notifyMode: 'openclaw',
    };
    repository = new JobQueueRepository(config);
  });

  it('picks the oldest queued job first and only runs one at a time', async () => {
    let resolveExecution: (() => void) | undefined;
    const execute = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<OmxExecutionResult>((resolve) => {
            resolveExecution = () => resolve(createExecutionResult());
          }),
      )
      .mockResolvedValue(createExecutionResult());
    const runner = new JobRunnerService(
      repository,
      { execute } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await repository.save(
      createJob({ id: '00000000-0000-4000-a000-000000000002', createdAt: '2026-04-02T00:00:02.000Z' }),
    );
    await repository.save(
      createJob({ id: '00000000-0000-4000-a000-000000000001', createdAt: '2026-04-02T00:00:01.000Z' }),
    );

    const firstRun = runner.runOnce();
    expect(await runner.runOnce()).toBe(false);

    const runningJob = await waitFor(
      () => repository.getById('00000000-0000-4000-a000-000000000001'),
      (job) => job?.status === 'running',
    );
    expect(runningJob?.status).toBe('running');
    expect(execute).toHaveBeenCalledWith('hello', expect.any(Object));

    resolveExecution?.();
    await firstRun;

    const completedJob = await repository.getById('00000000-0000-4000-a000-000000000001');
    expect(completedJob?.status).toBe('succeeded');

    await waitFor(
      () => Promise.resolve(execute.mock.calls.length),
      (callCount) => callCount === 2,
    );
  });

  it('marks failed results when the omx execution fails', async () => {
    const runner = new JobRunnerService(
      repository,
      {
        execute: jest
          .fn()
          .mockResolvedValue(
            createExecutionResult({
              status: 'failed',
              stderr: 'boom',
              exitCode: 1,
              execution: {
                command: 'omx',
                timeoutMs: 1000,
                maxOutputChars: 1000,
                errorType: 'non_zero_exit',
              },
            }),
          ),
      } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await repository.save(createJob());
    await runner.runOnce();

    await expect(repository.getById('00000000-0000-4000-a000-000000000001')).resolves.toMatchObject({
      status: 'failed',
      stderr: 'boom',
      exitCode: 1,
    });
  });

  it('aborts running jobs and preserves external terminal updates', async () => {
    let abortSignal: AbortSignal | undefined;
    let resolveExecution: (() => void) | undefined;
    const runner = new JobRunnerService(
      repository,
      {
        execute: jest.fn().mockImplementation(
          (_prompt: string, options?: { signal?: AbortSignal }) =>
            new Promise<OmxExecutionResult>((resolve) => {
              abortSignal = options?.signal;
              resolveExecution = () =>
                resolve(
                  createExecutionResult({
                    status: 'cancelled',
                    stderr: 'Command cancelled',
                    exitCode: null,
                    execution: {
                      command: 'omx',
                      timeoutMs: 1000,
                      maxOutputChars: 1000,
                      errorType: 'cancelled',
                    },
                  }),
                );
            }),
        ),
      } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await repository.save(createJob());

    const runPromise = runner.runOnce();
    await waitFor(
      () => repository.getById('00000000-0000-4000-a000-000000000001'),
      (job) => job?.status === 'running',
    );

    expect(await runner.cancel('00000000-0000-4000-a000-000000000001')).toBe(true);
    expect(abortSignal?.aborted).toBe(true);

    await repository.save(
      createJob({
        status: 'cancelled',
        finishedAt: '2026-04-02T00:00:05.000Z',
        stderr: 'Cancelled by API request',
        execution: {
          command: 'omx',
          timeoutMs: 1000,
          maxOutputChars: 1000,
          errorType: 'cancelled',
        },
      }),
    );

    resolveExecution?.();
    await runPromise;

    await expect(repository.getById('00000000-0000-4000-a000-000000000001')).resolves.toMatchObject({
      status: 'cancelled',
      stderr: 'Cancelled by API request',
    });
  });

  it('runs up to maxConcurrency jobs in parallel and respects the cap', async () => {
    config.maxConcurrency = 2;

    const releasers: Array<() => void> = [];
    const execute = jest.fn().mockImplementation(
      () =>
        new Promise<OmxExecutionResult>((resolve) => {
          releasers.push(() => resolve(createExecutionResult()));
        }),
    );
    const runner = new JobRunnerService(
      repository,
      { execute } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await repository.save(
      createJob({
        id: '00000000-0000-4000-a000-000000000001',
        queueOrder: '0000000000001-000001',
        createdAt: '2026-04-02T00:00:01.000Z',
      }),
    );
    await repository.save(
      createJob({
        id: '00000000-0000-4000-a000-000000000002',
        queueOrder: '0000000000002-000002',
        createdAt: '2026-04-02T00:00:02.000Z',
      }),
    );
    await repository.save(
      createJob({
        id: '00000000-0000-4000-a000-000000000003',
        queueOrder: '0000000000003-000003',
        createdAt: '2026-04-02T00:00:03.000Z',
      }),
    );

    const firstRun = runner.runOnce();
    const secondRun = runner.runOnce();
    const thirdRun = runner.runOnce();

    await waitFor(
      () => repository.getById('00000000-0000-4000-a000-000000000002'),
      (job) => job?.status === 'running',
    );

    const job1 = await repository.getById('00000000-0000-4000-a000-000000000001');
    const job2 = await repository.getById('00000000-0000-4000-a000-000000000002');
    const job3 = await repository.getById('00000000-0000-4000-a000-000000000003');
    expect(job1?.status).toBe('running');
    expect(job2?.status).toBe('running');
    expect(job3?.status).toBe('queued');
    expect(execute).toHaveBeenCalledTimes(2);

    expect(await thirdRun).toBe(false);

    releasers[0]?.();
    expect(await firstRun).toBe(true);

    const fourthRun = runner.runOnce();
    await waitFor(
      () => repository.getById('00000000-0000-4000-a000-000000000003'),
      (job) => job?.status === 'running',
    );
    expect(execute).toHaveBeenCalledTimes(3);

    releasers[1]?.();
    releasers[2]?.();
    await secondRun;
    await fourthRun;
  });

  it('trigger starts queued work without waiting for the polling interval', async () => {
    const execute = jest.fn().mockResolvedValue(createExecutionResult());
    const runner = new JobRunnerService(
      repository,
      { execute } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await repository.save(createJob());
    runner.trigger();

    await waitFor(
      () => repository.getById('00000000-0000-4000-a000-000000000001'),
      (job) => job?.status === 'succeeded',
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('recovers stranded running jobs by re-queueing them', async () => {
    await repository.save(
      createJob({
        status: 'running',
        startedAt: '2026-04-02T00:00:03.000Z',
        stderr: 'partial stderr',
      }),
    );
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await runner.recoverInterruptedJobs();

    const recovered = await repository.getById('00000000-0000-4000-a000-000000000001');
    expect(recovered).toMatchObject({
      status: 'queued',
      execution: { recoveredFromRestart: true },
    });
    expect(recovered?.startedAt).toBeUndefined();
    expect(recovered?.stderr).toContain('Recovered after process restart');
  });
});
