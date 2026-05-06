import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import { JobRunnerService } from '../../src/jobs/job-runner.service';
import type { BridgeJob, OmxExecutionResult } from '../../src/jobs/job.types';
import type { OmxExecService } from '../../src/jobs/omx-exec.service';
import type { JobNotifyService } from '../../src/jobs/job-notify.service';
import type { TmuxSessionRunnerService } from '../../src/jobs/tmux-session-runner.service';
import { createTempDir, waitFor } from '../helpers';

const mockJobNotify = {
  notifyJobComplete: jest.fn().mockResolvedValue(undefined),
} as unknown as JobNotifyService;

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? '00000000-0000-4000-a000-000000000001',
    prompt: overrides.prompt ?? 'hello',
    executionMode: overrides.executionMode,
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
    notifyUrl: overrides.notifyUrl,
    source: overrides.source,
    session: overrides.session,
    notifyOutcome: overrides.notifyOutcome,
    notifyHistory: overrides.notifyHistory,
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
    jest.mocked(mockJobNotify.notifyJobComplete).mockClear();
    config = {
      host: '127.0.0.1',
      jobsDirectory: await createTempDir('runner-jobs'),
      omxCommand: 'omx',
      tmuxCommand: 'tmux',
      tmuxSessionsDirectory: await createTempDir('runner-sessions'),
      jobPollIntervalMs: 10,
      jobTimeoutMs: 1000,
      maxOutputChars: 1000,
      sigkillGraceMs: 5000,
      maxConcurrency: 1,
      maxActiveJobs: 50,
      jobRetentionDays: 7,
      maxTerminalJobs: 1000,
      jobCleanupIntervalMs: 3600000,
      notifyTimeoutMs: 5000,
      notifyMode: 'openclaw',
      allowedCwdPrefixes: ['/workspace'],
    };
    repository = new JobQueueRepository(config);
  });

  it('picks the oldest queued job first and only runs one at a time', async () => {
    let resolveExecution!: () => void;
    const firstExecution = new Promise<OmxExecutionResult>((resolve) => {
      resolveExecution = () => resolve(createExecutionResult());
    });
    const execute = jest
      .fn()
      .mockReturnValueOnce(firstExecution)
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
    const secondRun = runner.runOnce();

    const runningJob = await waitFor(
      () => repository.getById('00000000-0000-4000-a000-000000000001'),
      (job) => job?.status === 'running',
    );
    expect(runningJob?.status).toBe('running');
    expect(execute).toHaveBeenCalledWith('hello', expect.any(Object));
    await expect(repository.getById('00000000-0000-4000-a000-000000000002')).resolves.toMatchObject({
      status: 'queued',
    });

    resolveExecution();
    const runResults = await Promise.all([firstRun, secondRun]);
    expect(runResults).toEqual(expect.arrayContaining([true, false]));

    const completedJob = await repository.getById('00000000-0000-4000-a000-000000000001');
    expect(completedJob?.status).toBe('succeeded');
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

  it('marks running jobs failed when omx execution rejects unexpectedly', async () => {
    const runner = new JobRunnerService(
      repository,
      {
        execute: jest.fn().mockRejectedValue(new Error('wrapper crashed')),
      } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await repository.save(createJob());

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(repository.getById('00000000-0000-4000-a000-000000000001')).resolves.toMatchObject({
      status: 'failed',
      stderr: 'Unexpected OMX execution error: wrapper crashed',
      exitCode: null,
      execution: { errorType: 'execution_error' },
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

  it('waits for aborted running jobs to settle during module destroy', async () => {
    let abortSignal: AbortSignal | undefined;
    const runner = new JobRunnerService(
      repository,
      {
        execute: jest.fn().mockImplementation(
          (_prompt: string, options?: { signal?: AbortSignal }) =>
            new Promise<OmxExecutionResult>((resolve) => {
              abortSignal = options?.signal;
              options?.signal?.addEventListener('abort', () => {
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
              }, { once: true });
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

    await runner.onModuleDestroy();
    await runPromise;

    expect(abortSignal?.aborted).toBe(true);
    await expect(repository.getById('00000000-0000-4000-a000-000000000001')).resolves.toMatchObject({
      status: 'cancelled',
      stderr: 'Command cancelled',
      execution: { errorType: 'cancelled' },
    });
  });

  it('waits for completion notifications to flush during module destroy', async () => {
    let abortSignal: AbortSignal | undefined;
    let resolveNotification: (() => void) | undefined;
    const notifyJobComplete = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveNotification = resolve;
        }),
    );
    const runner = new JobRunnerService(
      repository,
      {
        execute: jest.fn().mockImplementation(
          (_prompt: string, options?: { signal?: AbortSignal }) =>
            new Promise<OmxExecutionResult>((resolve) => {
              abortSignal = options?.signal;
              options?.signal?.addEventListener('abort', () => {
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
              }, { once: true });
            }),
        ),
      } as unknown as OmxExecService,
      { notifyJobComplete } as unknown as JobNotifyService,
      config,
    );

    await repository.save(createJob());

    const runPromise = runner.runOnce();
    await waitFor(
      () => repository.getById('00000000-0000-4000-a000-000000000001'),
      (job) => job?.status === 'running',
    );

    let destroySettled = false;
    const destroyPromise = runner.onModuleDestroy().then(() => {
      destroySettled = true;
    });
    await waitFor(
      () => Promise.resolve(notifyJobComplete.mock.calls.length),
      (callCount) => callCount === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(abortSignal?.aborted).toBe(true);
    expect(destroySettled).toBe(false);

    resolveNotification?.();
    await destroyPromise;
    await runPromise;

    expect(destroySettled).toBe(true);
  });

  it('stops waiting for stuck completion notifications after the shutdown grace timeout', async () => {
    jest.useFakeTimers();
    try {
      const notifyJobComplete = jest.fn().mockReturnValue(new Promise<void>(() => undefined));
      const runner = new JobRunnerService(
        repository,
        {
          execute: jest.fn().mockResolvedValue(createExecutionResult()),
        } as unknown as OmxExecService,
        { notifyJobComplete } as unknown as JobNotifyService,
        config,
      );

      await repository.save(createJob());
      await runner.runOnce();

      let destroySettled = false;
      const destroyPromise = runner.onModuleDestroy().then(() => {
        destroySettled = true;
      });
      await Promise.resolve();

      expect(destroySettled).toBe(false);

      jest.advanceTimersByTime(config.sigkillGraceMs + 2_000);
      await destroyPromise;

      expect(destroySettled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs up to maxConcurrency jobs in parallel and respects the cap', async () => {
    config.maxConcurrency = 2;

    const releasers: Array<() => void> = [];
    const pendingExecutions = Array.from({ length: 3 }, () =>
      new Promise<OmxExecutionResult>((resolve) => {
        releasers.push(() => resolve(createExecutionResult()));
      }),
    );
    const execute = jest
      .fn()
      .mockReturnValueOnce(pendingExecutions[0])
      .mockReturnValueOnce(pendingExecutions[1])
      .mockReturnValueOnce(pendingExecutions[2]);
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

    expect(releasers).toHaveLength(3);
    releasers[0]();
    releasers[1]();
    releasers[2]();
    const runResults = await Promise.all([firstRun, secondRun, thirdRun]);
    expect(runResults.filter(Boolean)).toHaveLength(2);
    expect(runResults.filter((result) => !result)).toHaveLength(1);

    await runner.runOnce();
    await waitFor(
      () => repository.getById('00000000-0000-4000-a000-000000000003'),
      (job) => job?.status === 'succeeded',
    );
    expect(execute).toHaveBeenCalledTimes(3);
  }, 10_000);

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

  it('starts queued tmux jobs through the tmux session runner without exec', async () => {
    const execute = jest.fn().mockResolvedValue(createExecutionResult());
    const tmuxSessionRunner = {
      collect: jest.fn().mockResolvedValue(null),
      start: jest.fn().mockResolvedValue({
        backend: 'tmux',
        sessionName: 'omx-bridge-test',
        status: 'running',
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:01.000Z',
        attachCommand: 'tmux attach -t omx-bridge-test',
      }),
    };
    const runner = new JobRunnerService(
      repository,
      { execute } as unknown as OmxExecService,
      mockJobNotify,
      config,
      tmuxSessionRunner as unknown as TmuxSessionRunnerService,
    );

    await repository.save(createJob({ executionMode: 'tmux' }));

    await expect(runner.runOnce()).resolves.toBe(true);

    const job = await repository.getById('00000000-0000-4000-a000-000000000001');
    expect(job).toMatchObject({
      executionMode: 'tmux',
      status: 'running',
      exitCode: null,
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-test',
        status: 'running',
      },
    });
    expect(job?.startedAt).toBeDefined();
    expect(job?.finishedAt).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(tmuxSessionRunner.start).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: 'tmux',
      status: 'running',
    }));
    expect(mockJobNotify.notifyJobComplete).not.toHaveBeenCalled();
  });

  it('collects finished tmux jobs and tracks completion notification', async () => {
    const collect = jest.fn().mockResolvedValue({
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-test',
        status: 'exited',
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:02.000Z',
        attachCommand: 'tmux attach -t omx-bridge-test',
        lastExitCode: 0,
      },
      result: createExecutionResult({
        stdout: 'tmux done',
        execution: {
          command: 'tmux',
          timeoutMs: 1000,
          maxOutputChars: 1000,
          durationMs: 2000,
        },
      }),
    });
    const notifyJobComplete = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      { notifyJobComplete } as unknown as JobNotifyService,
      config,
      { collect } as unknown as TmuxSessionRunnerService,
    );

    await repository.save(createJob({
      executionMode: 'tmux',
      status: 'running',
      startedAt: '2026-04-02T00:00:00.000Z',
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-test',
        status: 'running',
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:01.000Z',
        attachCommand: 'tmux attach -t omx-bridge-test',
      },
    }));

    await expect(runner.runOnce()).resolves.toBe(true);

    await expect(repository.getById('00000000-0000-4000-a000-000000000001')).resolves.toMatchObject({
      executionMode: 'tmux',
      status: 'succeeded',
      stdout: 'tmux done',
      exitCode: 0,
      session: {
        status: 'exited',
        lastExitCode: 0,
      },
    });
    expect(notifyJobComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'succeeded',
      executionMode: 'tmux',
    }));
  });

  it('marks stranded running jobs failed without re-queueing them', async () => {
    await repository.save(
      createJob({
        status: 'running',
        startedAt: '2026-04-02T00:00:03.000Z',
        stderr: 'partial stderr',
      }),
    );
    const execute = jest.fn();
    const runner = new JobRunnerService(
      repository,
      { execute } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await runner.recoverInterruptedJobs();

    const recovered = await repository.getById('00000000-0000-4000-a000-000000000001');
    expect(recovered).toMatchObject({
      status: 'failed',
      exitCode: null,
      stdout: '',
      execution: {
        errorType: 'execution_error',
        recoveredFromRestart: true,
      },
    });
    expect(recovered?.startedAt).toBe('2026-04-02T00:00:03.000Z');
    expect(recovered?.finishedAt).toBeDefined();
    expect(Date.parse(recovered?.finishedAt ?? '')).not.toBeNaN();
    expect(recovered?.stderr).toContain('partial stderr');
    expect(recovered?.stderr).toContain('Process was interrupted by service restart before completion.');
    await expect(runner.runOnce()).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not modify terminal jobs during interrupted job recovery', async () => {
    const succeeded = createJob({
      id: '00000000-0000-4000-a000-000000000001',
      status: 'succeeded',
      finishedAt: '2026-04-02T00:00:05.000Z',
      exitCode: 0,
      stdout: 'done',
      execution: { command: 'omx', timeoutMs: 1000, maxOutputChars: 1000, durationMs: 10 },
    });
    const failed = createJob({
      id: '00000000-0000-4000-a000-000000000002',
      status: 'failed',
      finishedAt: '2026-04-02T00:00:06.000Z',
      exitCode: 1,
      stderr: 'boom',
      execution: {
        command: 'omx',
        timeoutMs: 1000,
        maxOutputChars: 1000,
        errorType: 'non_zero_exit',
      },
    });
    const cancelled = createJob({
      id: '00000000-0000-4000-a000-000000000003',
      status: 'cancelled',
      finishedAt: '2026-04-02T00:00:07.000Z',
      execution: {
        command: 'omx',
        timeoutMs: 1000,
        maxOutputChars: 1000,
        errorType: 'cancelled',
      },
    });
    await repository.save(succeeded);
    await repository.save(failed);
    await repository.save(cancelled);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await runner.recoverInterruptedJobs();

    await expect(repository.getById(succeeded.id)).resolves.toEqual(succeeded);
    await expect(repository.getById(failed.id)).resolves.toEqual(failed);
    await expect(repository.getById(cancelled.id)).resolves.toEqual(cancelled);
  });

  it('keeps interrupted job recovery idempotent', async () => {
    await repository.save(
      createJob({
        status: 'running',
        startedAt: '2026-04-02T00:00:03.000Z',
      }),
    );
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    await runner.recoverInterruptedJobs();
    const recoveredOnce = await repository.getById('00000000-0000-4000-a000-000000000001');
    await runner.recoverInterruptedJobs();
    const recoveredTwice = await repository.getById('00000000-0000-4000-a000-000000000001');

    expect(recoveredTwice).toEqual(recoveredOnce);
  });

  it('marks stranded running jobs failed and reconciles their notification during module initialization', async () => {
    const notifyJobComplete = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      { notifyJobComplete } as unknown as JobNotifyService,
      config,
    );
    await repository.save(
      createJob({
        status: 'running',
        startedAt: '2026-04-02T00:00:03.000Z',
      }),
    );

    try {
      await runner.onModuleInit();
      const recovered = await repository.getById('00000000-0000-4000-a000-000000000001');
      expect(recovered).toMatchObject({
        status: 'failed',
        stdout: '',
        execution: {
          errorType: 'execution_error',
          recoveredFromRestart: true,
        },
      });
      await waitFor(
        () => Promise.resolve(notifyJobComplete.mock.calls.length),
        (callCount) => callCount === 1,
      );
      expect(notifyJobComplete).toHaveBeenCalledWith(expect.objectContaining({
        id: '00000000-0000-4000-a000-000000000001',
        status: 'failed',
        stdout: '',
        execution: expect.objectContaining({
          errorType: 'execution_error',
          recoveredFromRestart: true,
        }),
      }));
    } finally {
      await runner.onModuleDestroy();
    }
  });

  it('reconciles only terminal jobs with missing notification outcomes at startup', async () => {
    const notifyJobComplete = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      { notifyJobComplete } as unknown as JobNotifyService,
      config,
    );
    const missingNotify = createJob({
      id: '00000000-0000-4000-a000-000000000001',
      status: 'succeeded',
      finishedAt: '2026-04-02T00:00:05.000Z',
    });
    const missingNotifyWithFullHistory = createJob({
      id: '00000000-0000-4000-a000-000000000007',
      status: 'failed',
      finishedAt: '2026-04-02T00:00:14.000Z',
      notifyHistory: Array.from({ length: 10 }, (_, index) => ({
        attemptedAt: `2026-04-02T00:01:${String(index).padStart(2, '0')}.000Z`,
        mode: 'claude' as const,
        claudeWebhook: { status: 'failed' as const, error: 'fetch_error' },
        attemptIndex: index,
      })),
    });
    const failedNotify = createJob({
      id: '00000000-0000-4000-a000-000000000002',
      status: 'failed',
      finishedAt: '2026-04-02T00:00:06.000Z',
      notifyOutcome: {
        attemptedAt: '2026-04-02T00:00:07.000Z',
        mode: 'claude',
        claudeWebhook: { status: 'failed', error: 'fetch_error' },
        telegram: { status: 'skipped', skippedReason: 'per_job_webhook_failed' },
      },
      notifyHistory: Array.from({ length: 10 }, (_, index) => ({
        attemptedAt: `2026-04-02T00:00:${String(index).padStart(2, '0')}.000Z`,
        mode: 'claude' as const,
        claudeWebhook: { status: 'failed' as const, error: 'fetch_error' },
        attemptIndex: index,
      })),
    });
    await repository.save(missingNotify);
    await repository.save(missingNotifyWithFullHistory);
    await repository.save(failedNotify);
    await repository.save(createJob({
      id: '00000000-0000-4000-a000-000000000003',
      status: 'succeeded',
      finishedAt: '2026-04-02T00:00:08.000Z',
      notifyOutcome: {
        attemptedAt: '2026-04-02T00:00:09.000Z',
        mode: 'claude',
        claudeWebhook: { status: 'ok' },
        telegram: { status: 'skipped', skippedReason: 'webhook_ok' },
      },
    }));
    await repository.save(createJob({
      id: '00000000-0000-4000-a000-000000000004',
      status: 'cancelled',
      finishedAt: '2026-04-02T00:00:10.000Z',
      notifyOutcome: {
        attemptedAt: '2026-04-02T00:00:11.000Z',
        mode: 'openclaw',
        openclaw: { status: 'skipped', skippedReason: 'not_configured' },
        telegram: { status: 'skipped', skippedReason: 'not_configured' },
      },
    }));
    await repository.save(createJob({
      id: '00000000-0000-4000-a000-000000000006',
      status: 'succeeded',
      finishedAt: '2026-04-02T00:00:12.000Z',
      notifyOutcome: {
        attemptedAt: '2026-04-02T00:00:13.000Z',
        mode: 'claude',
        claudeWebhook: { status: 'ok' },
        telegram: { status: 'failed', error: 'fetch_error' },
      },
    }));
    await repository.save(createJob({
      id: '00000000-0000-4000-a000-000000000005',
      status: 'queued',
    }));

    await expect(runner.reconcileTerminalNotifications()).resolves.toBe(2);

    expect(notifyJobComplete).toHaveBeenCalledTimes(2);
    expect(notifyJobComplete).toHaveBeenNthCalledWith(1, missingNotify);
    expect(notifyJobComplete).toHaveBeenNthCalledWith(2, missingNotifyWithFullHistory);
    expect(notifyJobComplete).not.toHaveBeenCalledWith(failedNotify);
  });

  it('starts notification reconciliation during module initialization', async () => {
    const notifyJobComplete = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      { notifyJobComplete } as unknown as JobNotifyService,
      config,
    );
    await repository.save(createJob({
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
    }));

    try {
      await runner.onModuleInit();
      await waitFor(
        () => Promise.resolve(notifyJobComplete.mock.calls.length),
        (callCount) => callCount === 1,
      );
    } finally {
      await runner.onModuleDestroy();
    }
  });
});
