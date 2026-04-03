import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import { JobRunnerService } from '../../src/jobs/job-runner.service';
import type { BridgeJob, OmxExecutionResult } from '../../src/jobs/job.types';
import type { OmxExecService } from '../../src/jobs/omx-exec.service';
import { createTempDir, waitFor } from '../helpers';

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? 'job-1',
    prompt: overrides.prompt ?? 'hello',
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
      config,
    );

    await repository.create(
      createJob({ id: 'job-2', createdAt: '2026-04-02T00:00:02.000Z' }),
    );
    await repository.create(
      createJob({ id: 'job-1', createdAt: '2026-04-02T00:00:01.000Z' }),
    );

    const firstRun = runner.runOnce();
    expect(await runner.runOnce()).toBe(false);

    const runningJob = await waitFor(
      () => repository.getById('job-1'),
      (job) => job?.status === 'running',
    );
    expect(runningJob?.status).toBe('running');
    expect(execute).toHaveBeenCalledWith('hello');

    resolveExecution?.();
    await firstRun;

    const completedJob = await repository.getById('job-1');
    expect(completedJob?.status).toBe('succeeded');

    await runner.runOnce();
    expect(execute).toHaveBeenCalledTimes(2);
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
      config,
    );

    await repository.create(createJob());
    await runner.runOnce();

    await expect(repository.getById('job-1')).resolves.toMatchObject({
      status: 'failed',
      stderr: 'boom',
      exitCode: 1,
    });
  });

  it('recovers stranded running jobs by re-queueing them', async () => {
    await repository.create(
      createJob({
        status: 'running',
        startedAt: '2026-04-02T00:00:03.000Z',
        stderr: 'partial stderr',
      }),
    );
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      config,
    );

    await runner.recoverInterruptedJobs();

    const recovered = await repository.getById('job-1');
    expect(recovered).toMatchObject({
      status: 'queued',
      execution: { recoveredFromRestart: true },
    });
    expect(recovered?.startedAt).toBeUndefined();
    expect(recovered?.stderr).toContain('Recovered after process restart');
  });
});
