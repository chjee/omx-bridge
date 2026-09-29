import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import { JobRunnerService } from '../../src/jobs/job-runner.service';
import type { BridgeJob, OmxExecutionResult } from '../../src/jobs/job.types';
import type { OmxExecService } from '../../src/jobs/omx-exec.service';
import type { JobNotifyService } from '../../src/jobs/job-notify.service';
import { TmuxSessionRunnerService, type TmuxSpawnFunction } from '../../src/jobs/tmux-session-runner.service';
import type { BridgeInstanceLockService } from '../../src/jobs/bridge-instance-lock.service';
import { createTempDir, waitFor } from '../helpers';

const mockJobNotify = {
  notifyJobComplete: jest.fn().mockResolvedValue(undefined),
} as unknown as JobNotifyService;

function canonicalSessionName(jobId: string): string {
  return `omx-bridge-${jobId.replace(/-/g, '').slice(0, 24)}`;
}

function tmuxProbe(code: number, stderr = ''): ReturnType<TmuxSpawnFunction> {
  const child = new EventEmitter() as ReturnType<TmuxSpawnFunction>;
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: jest.fn(() => true),
  });
  setImmediate(() => {
    if (stderr) (child.stderr as PassThrough).write(stderr);
    child.emit('close', code);
  });
  return child;
}

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
      insecureLoopback: false,
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

  it('retains the lock until timed-out in-flight completion and notification settle', async () => {
    jest.useFakeTimers();
    try {
      config.sigkillGraceMs = 1;
      const graceWindowMs = config.sigkillGraceMs + 2_000;
      const events: string[] = [];
      let abortSignal: AbortSignal | undefined;
      let markExecutionStarted!: () => void;
      const executionStarted = new Promise<void>((resolve) => { markExecutionStarted = resolve; });
      let resolveExecution!: () => void;
      const executionBarrier = new Promise<OmxExecutionResult>((resolve) => {
        resolveExecution = () => resolve(createExecutionResult({
          status: 'cancelled',
          stderr: 'Command cancelled',
          exitCode: null,
          execution: {
            command: 'omx', timeoutMs: 1000, maxOutputChars: 1000,
            errorType: 'cancelled',
          },
        }));
      });
      let releaseNotification!: () => void;
      const notificationBarrier = new Promise<void>((resolve) => { releaseNotification = resolve; });
      let markNotificationFinished!: () => void;
      const notificationFinished = new Promise<void>((resolve) => { markNotificationFinished = resolve; });
      const notifyJobComplete = jest.fn(async () => {
        events.push('notification-start');
        await notificationBarrier;
        events.push('notification-finish');
        markNotificationFinished();
      });
      let markLockReleased!: () => void;
      const lockReleased = new Promise<void>((resolve) => { markLockReleased = resolve; });
      const releaseLock = jest.fn(async () => {
        events.push('lock-release');
        markLockReleased();
      });
      const originalTransition = repository.transition.bind(repository);
      jest.spyOn(repository, 'transition').mockImplementation(async (...args) => {
        const result = await originalTransition(...args);
        if (args[1].includes('running') && result.transitioned && result.job?.status === 'cancelled') {
          events.push('terminal-transition');
        }
        return result;
      });
      const runner = new JobRunnerService(
        repository,
        {
          execute: jest.fn((_prompt: string, options?: { signal?: AbortSignal }) => {
            abortSignal = options?.signal;
            markExecutionStarted();
            return executionBarrier;
          }),
        } as unknown as OmxExecService,
        { notifyJobComplete } as unknown as JobNotifyService,
        config,
        undefined,
        { release: releaseLock } as unknown as BridgeInstanceLockService,
      );
      await repository.save(createJob());

      let runSettled = false;
      const run = runner.runOnce().finally(() => { runSettled = true; });
      await executionStarted;
      const destroy = runner.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(graceWindowMs + 1);
      await destroy;

      expect(abortSignal?.aborted).toBe(true);
      expect(runSettled).toBe(false);
      expect(releaseLock).not.toHaveBeenCalled();
      expect(events).toEqual([]);

      resolveExecution();
      await run;
      await Promise.resolve();

      expect(events).toEqual([
        'terminal-transition',
        'notification-start',
      ]);
      expect(releaseLock).not.toHaveBeenCalled();

      releaseNotification();
      await notificationFinished;
      await lockReleased;

      expect(events).toEqual([
        'terminal-transition',
        'notification-start',
        'notification-finish',
        'lock-release',
      ]);
      expect(releaseLock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains the lock while a timed-out in-flight terminal transition is pending', async () => {
    jest.useFakeTimers();
    try {
      config.sigkillGraceMs = 1;
      const graceWindowMs = config.sigkillGraceMs + 2_000;
      const events: string[] = [];
      let markExecutionStarted!: () => void;
      const executionStarted = new Promise<void>((resolve) => { markExecutionStarted = resolve; });
      let markTransitionStarted!: () => void;
      const transitionStarted = new Promise<void>((resolve) => { markTransitionStarted = resolve; });
      let releaseTransition!: () => void;
      const transitionBarrier = new Promise<void>((resolve) => { releaseTransition = resolve; });
      let releaseNotification!: () => void;
      const notificationBarrier = new Promise<void>((resolve) => { releaseNotification = resolve; });
      let markNotificationStarted!: () => void;
      const notificationStarted = new Promise<void>((resolve) => { markNotificationStarted = resolve; });
      let markLockReleased!: () => void;
      const lockReleased = new Promise<void>((resolve) => { markLockReleased = resolve; });
      const originalTransition = repository.transition.bind(repository);
      jest.spyOn(repository, 'transition').mockImplementation(async (...args) => {
        if (args[1].includes('running')) {
          markTransitionStarted();
          await transitionBarrier;
        }
        const result = await originalTransition(...args);
        if (args[1].includes('running') && result.transitioned) events.push('terminal-transition');
        return result;
      });
      const notifyJobComplete = jest.fn(async () => {
        events.push('notification-start');
        markNotificationStarted();
        await notificationBarrier;
        events.push('notification-finish');
      });
      const releaseLock = jest.fn(async () => {
        events.push('lock-release');
        markLockReleased();
      });
      const runner = new JobRunnerService(
        repository,
        {
          execute: jest.fn((_prompt: string, options?: { signal?: AbortSignal }) => {
            markExecutionStarted();
            return new Promise<OmxExecutionResult>((resolve) => {
              options?.signal?.addEventListener('abort', () => {
                resolve(createExecutionResult({
                  status: 'cancelled',
                  stderr: 'Command cancelled',
                  exitCode: null,
                  execution: {
                    command: 'omx', timeoutMs: 1000, maxOutputChars: 1000,
                    errorType: 'cancelled',
                  },
                }));
              }, { once: true });
            });
          }),
        } as unknown as OmxExecService,
        { notifyJobComplete } as unknown as JobNotifyService,
        config,
        undefined,
        { release: releaseLock } as unknown as BridgeInstanceLockService,
      );
      await repository.save(createJob());

      const run = runner.runOnce();
      await executionStarted;
      const destroy = runner.onModuleDestroy();
      await transitionStarted;
      await jest.advanceTimersByTimeAsync(graceWindowMs + 1);
      await destroy;

      expect(releaseLock).not.toHaveBeenCalled();
      expect(events).toEqual([]);

      releaseTransition();
      await run;
      await notificationStarted;

      expect(events).toEqual(['terminal-transition', 'notification-start']);
      expect(releaseLock).not.toHaveBeenCalled();

      releaseNotification();
      await lockReleased;

      expect(events).toEqual([
        'terminal-transition',
        'notification-start',
        'notification-finish',
        'lock-release',
      ]);
      expect(releaseLock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
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
      await (runner as unknown as {
        reconcileRunningTmuxJobs: () => Promise<number>;
      }).reconcileRunningTmuxJobs();

      let destroySettled = false;
      const destroyPromise = runner.onModuleDestroy().then(() => {
        destroySettled = true;
      });
      for (let attempt = 0; attempt < 10 && jest.getTimerCount() === 0; attempt += 1) {
        await Promise.resolve();
      }

      expect(destroySettled).toBe(false);
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      await jest.advanceTimersByTimeAsync(config.sigkillGraceMs + 2_000);
      await destroyPromise;

      expect(destroySettled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for pending tmux reconciliation and does not claim queued work after shutdown', async () => {
    config.maxConcurrency = 2;
    const runningTmuxJob = createJob({
      id: '00000000-0000-4000-a000-000000000001',
      executionMode: 'tmux',
      status: 'running',
      startedAt: '2026-04-02T00:00:00.000Z',
      session: {
        backend: 'tmux', sessionName: 'omx-bridge-running', status: 'running',
        createdAt: '2026-04-02T00:00:00.000Z', updatedAt: '2026-04-02T00:00:01.000Z',
        attachCommand: 'tmux attach -t omx-bridge-running',
      },
    });
    const queuedJob = createJob({
      id: '00000000-0000-4000-a000-000000000002',
      queueOrder: '0000000000002-000002',
      createdAt: '2026-04-02T00:00:02.000Z',
    });
    await repository.save(runningTmuxJob);
    await repository.save(queuedJob);
    let releaseCollect!: () => void;
    const collectBarrier = new Promise<null>((resolve) => { releaseCollect = () => resolve(null); });
    const collect = jest.fn(() => collectBarrier);
    const start = jest.fn();
    const execute = jest.fn().mockResolvedValue(createExecutionResult());
    const releaseLock = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute } as unknown as OmxExecService,
      mockJobNotify,
      config,
      { collect, start } as unknown as TmuxSessionRunnerService,
      { release: releaseLock } as unknown as BridgeInstanceLockService,
    );

    const run = runner.runOnce();
    await waitFor(() => Promise.resolve(collect.mock.calls.length), (count) => count === 1);
    let destroySettled = false;
    const destroy = runner.onModuleDestroy().then(() => { destroySettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stateWhileCollectPending = {
      destroySettled,
      releaseCalls: releaseLock.mock.calls.length,
    };

    releaseCollect();
    await Promise.all([run, destroy]);

    expect(stateWhileCollectPending).toEqual({ destroySettled: false, releaseCalls: 0 });
    expect(execute).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
    await expect(repository.getById(queuedJob.id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('retains the lock and leaves work queued when shutdown begins during the claim snapshot', async () => {
    const queuedJob = createJob();
    await repository.save(queuedJob);
    const listAll = repository.listAll.bind(repository);
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => { markSnapshotStarted = resolve; });
    let releaseSnapshot!: (jobs: BridgeJob[]) => void;
    const snapshotBarrier = new Promise<BridgeJob[]>((resolve) => { releaseSnapshot = resolve; });
    jest.spyOn(repository, 'listAll')
      .mockImplementationOnce(listAll)
      .mockImplementationOnce(async () => {
        markSnapshotStarted();
        return snapshotBarrier;
      });
    const execute = jest.fn().mockResolvedValue(createExecutionResult());
    const start = jest.fn();
    const releaseLock = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute } as unknown as OmxExecService,
      mockJobNotify,
      config,
      { start } as unknown as TmuxSessionRunnerService,
      { release: releaseLock } as unknown as BridgeInstanceLockService,
    );

    const run = runner.runOnce();
    await snapshotStarted;
    let destroySettled = false;
    const destroy = runner.onModuleDestroy().then(() => { destroySettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySettled).toBe(false);
    expect(releaseLock).not.toHaveBeenCalled();

    releaseSnapshot(await listAll());
    await Promise.all([run, destroy]);

    expect(execute).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
    await expect(repository.getById(queuedJob.id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('does not start a claimed tmux job when shutdown begins during execution lookup', async () => {
    const queuedJob = createJob({ executionMode: 'tmux' });
    await repository.save(queuedJob);
    const getById = repository.getById.bind(repository);
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
    let releaseLookup!: (job: BridgeJob | null) => void;
    const lookupBarrier = new Promise<BridgeJob | null>((resolve) => { releaseLookup = resolve; });
    jest.spyOn(repository, 'getById')
      .mockImplementationOnce(getById)
      .mockImplementationOnce(async () => {
        markLookupStarted();
        return lookupBarrier;
      });
    const execute = jest.fn();
    const start = jest.fn().mockResolvedValue({
      backend: 'tmux', sessionName: 'omx-bridge-late-start', status: 'running',
      createdAt: '2026-04-02T00:00:00.000Z', updatedAt: '2026-04-02T00:00:00.000Z',
      attachCommand: 'tmux attach -t omx-bridge-late-start',
    });
    const releaseLock = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute } as unknown as OmxExecService,
      mockJobNotify,
      config,
      { start } as unknown as TmuxSessionRunnerService,
      { release: releaseLock } as unknown as BridgeInstanceLockService,
    );

    const run = runner.runOnce();
    await lookupStarted;
    const destroy = runner.onModuleDestroy();
    releaseLookup(await getById(queuedJob.id));
    await Promise.all([run, destroy]);

    expect(execute).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
    await expect(repository.getById(queuedJob.id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('flushes a reconciliation completion notification before releasing the instance lock', async () => {
    const runningTmuxJob = createJob({
      executionMode: 'tmux',
      status: 'running',
      startedAt: '2026-04-02T00:00:00.000Z',
      session: {
        backend: 'tmux', sessionName: 'omx-bridge-completing', status: 'running',
        createdAt: '2026-04-02T00:00:00.000Z', updatedAt: '2026-04-02T00:00:01.000Z',
        attachCommand: 'tmux attach -t omx-bridge-completing',
      },
    });
    await repository.save(runningTmuxJob);
    const collected = {
      session: {
        ...runningTmuxJob.session!, status: 'exited' as const,
        updatedAt: '2026-04-02T00:00:02.000Z', lastExitCode: 0,
      },
      result: createExecutionResult({ stdout: 'tmux done' }),
    };
    let releaseCollect!: () => void;
    const collectBarrier = new Promise<typeof collected>((resolve) => {
      releaseCollect = () => resolve(collected);
    });
    let releaseNotification!: () => void;
    const notificationBarrier = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const notifyJobComplete = jest.fn(() => notificationBarrier);
    const releaseLock = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      { notifyJobComplete } as unknown as JobNotifyService,
      config,
      { collect: jest.fn(() => collectBarrier) } as unknown as TmuxSessionRunnerService,
      { release: releaseLock } as unknown as BridgeInstanceLockService,
    );

    const run = runner.runOnce();
    await Promise.resolve();
    let destroySettled = false;
    const destroy = runner.onModuleDestroy().then(() => { destroySettled = true; });
    releaseCollect();
    await waitFor(() => Promise.resolve(notifyJobComplete.mock.calls.length), (count) => count === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stateWhileNotificationPending = {
      destroySettled,
      releaseCalls: releaseLock.mock.calls.length,
    };

    releaseNotification();
    await Promise.all([run, destroy]);

    expect(stateWhileNotificationPending).toEqual({ destroySettled: false, releaseCalls: 0 });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('isolates tmux reconciliation rejection during shutdown and clears the guard', async () => {
    const runningTmuxJob = createJob({
      executionMode: 'tmux',
      status: 'running',
      session: {
        backend: 'tmux', sessionName: 'omx-bridge-rejecting', status: 'running',
        createdAt: '2026-04-02T00:00:00.000Z', updatedAt: '2026-04-02T00:00:01.000Z',
        attachCommand: 'tmux attach -t omx-bridge-rejecting',
      },
    });
    await repository.save(runningTmuxJob);
    let rejectCollect!: (error: Error) => void;
    const collectBarrier = new Promise<null>((_resolve, reject) => { rejectCollect = reject; });
    const collect = jest.fn()
      .mockReturnValueOnce(collectBarrier)
      .mockResolvedValue(null);
    const execute = jest.fn();
    const releaseLock = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute } as unknown as OmxExecService,
      mockJobNotify,
      config,
      { collect } as unknown as TmuxSessionRunnerService,
      { release: releaseLock } as unknown as BridgeInstanceLockService,
    );
    const warn = jest.spyOn((runner as unknown as {
      logger: { warn: (message: string) => void };
    }).logger, 'warn');

    const run = runner.runOnce();
    await waitFor(() => Promise.resolve(collect.mock.calls.length), (count) => count === 1);
    let destroySettled = false;
    const destroy = runner.onModuleDestroy().then(() => { destroySettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stateWhileCollectPending = {
      destroySettled,
      releaseCalls: releaseLock.mock.calls.length,
    };

    rejectCollect(new Error('tmux reconcile failed'));
    await expect(destroy).resolves.toBeUndefined();
    await expect(run).resolves.toBe(false);
    await expect((runner as unknown as {
      reconcileRunningTmuxJobs: () => Promise<number>;
    }).reconcileRunningTmuxJobs()).resolves.toBe(0);

    expect(stateWhileCollectPending).toEqual({ destroySettled: false, releaseCalls: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tmux reconciliation'));
    expect(collect).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('retains the instance lock until timed-out reconciliation and cleanup both settle', async () => {
    jest.useFakeTimers();
    try {
      config.sigkillGraceMs = 1;
      const runningTmuxJob = createJob({
        executionMode: 'tmux',
        status: 'running',
        session: {
          backend: 'tmux', sessionName: 'omx-bridge-stuck', status: 'running',
          createdAt: '2026-04-02T00:00:00.000Z', updatedAt: '2026-04-02T00:00:01.000Z',
          attachCommand: 'tmux attach -t omx-bridge-stuck',
        },
      });
      await repository.save(runningTmuxJob);
      jest.spyOn(repository, 'listByStatus').mockResolvedValue([runningTmuxJob]);
      let releaseCollect!: () => void;
      const collected = {
        session: {
          ...runningTmuxJob.session!, status: 'exited' as const,
          updatedAt: '2026-04-02T00:00:02.000Z', lastExitCode: 0,
        },
        result: createExecutionResult({ stdout: 'late tmux done' }),
      };
      const collectBarrier = new Promise<typeof collected>((resolve) => {
        releaseCollect = () => resolve(collected);
      });
      let releaseCleanup!: () => void;
      const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      jest.spyOn(repository, 'cleanupTerminalJobs').mockImplementation(async () => {
        await cleanupBarrier;
        return { deleted: 0, retained: 0, deletedEntries: [] };
      });
      let releaseNotification!: () => void;
      const notificationBarrier = new Promise<void>((resolve) => { releaseNotification = resolve; });
      const notifyJobComplete = jest.fn(() => notificationBarrier);
      const releaseLock = jest.fn().mockResolvedValue(undefined);
      const runner = new JobRunnerService(
        repository,
        { execute: jest.fn() } as unknown as OmxExecService,
        { notifyJobComplete } as unknown as JobNotifyService,
        config,
        { collect: jest.fn(() => collectBarrier) } as unknown as TmuxSessionRunnerService,
        { release: releaseLock } as unknown as BridgeInstanceLockService,
      );

      const run = runner.runOnce();
      await Promise.resolve();
      const cleanup = runner.cleanupTerminalJobs();
      const destroy = runner.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(2_002);
      await destroy;

      expect(releaseLock).not.toHaveBeenCalled();
      releaseCleanup();
      await cleanup;
      await Promise.resolve();
      const releaseCallsWithReconcilePending = releaseLock.mock.calls.length;
      releaseCollect();
      await run;
      await Promise.resolve();

      expect(notifyJobComplete).toHaveBeenCalledTimes(1);
      expect(releaseLock).not.toHaveBeenCalled();

      releaseNotification();
      await jest.runAllTimersAsync();
      await Promise.resolve();

      expect(releaseCallsWithReconcilePending).toBe(0);
      expect(releaseLock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds composite shutdown observers to two grace windows', async () => {
    jest.useFakeTimers();
    try {
      config.sigkillGraceMs = 1;
      const graceWindowMs = config.sigkillGraceMs + 2_000;
      const runningTmuxJob = createJob({
        executionMode: 'tmux',
        status: 'running',
        session: {
          backend: 'tmux', sessionName: 'omx-bridge-budget', status: 'running',
          createdAt: '2026-04-02T00:00:00.000Z', updatedAt: '2026-04-02T00:00:01.000Z',
          attachCommand: 'tmux attach -t omx-bridge-budget',
        },
      });
      await repository.save(runningTmuxJob);
      const collected = {
        session: {
          ...runningTmuxJob.session!, status: 'exited' as const,
          updatedAt: '2026-04-02T00:00:02.000Z', lastExitCode: 0,
        },
        result: createExecutionResult({ stdout: 'budget tmux done' }),
      };
      let releaseCollect!: () => void;
      let markCollectStarted!: () => void;
      const collectStarted = new Promise<void>((resolve) => { markCollectStarted = resolve; });
      const collectBarrier = new Promise<typeof collected>((resolve) => {
        releaseCollect = () => resolve(collected);
      });
      let releaseCleanup!: () => void;
      const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      jest.spyOn(repository, 'cleanupTerminalJobs').mockImplementation(async () => {
        await cleanupBarrier;
        return { deleted: 0, retained: 0, deletedEntries: [] };
      });
      let releaseNotification!: () => void;
      const notificationBarrier = new Promise<void>((resolve) => { releaseNotification = resolve; });
      const notifyJobComplete = jest.fn(() => notificationBarrier);
      const releaseLock = jest.fn().mockResolvedValue(undefined);
      const runner = new JobRunnerService(
        repository,
        { execute: jest.fn() } as unknown as OmxExecService,
        { notifyJobComplete } as unknown as JobNotifyService,
        config,
        {
          collect: jest.fn(() => {
            markCollectStarted();
            return collectBarrier;
          }),
        } as unknown as TmuxSessionRunnerService,
        { release: releaseLock } as unknown as BridgeInstanceLockService,
      );
      let releaseClaim!: () => void;
      const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
      let releaseInFlight!: () => void;
      const inFlightBarrier = new Promise<void>((resolve) => { releaseInFlight = resolve; });

      const run = runner.runOnce();
      await collectStarted;
      const cleanup = runner.cleanupTerminalJobs();
      const shutdownState = runner as unknown as {
        claimMutex: Promise<void>;
        inFlightRuns: Map<string, Promise<void>>;
      };
      shutdownState.claimMutex = claimBarrier;
      shutdownState.inFlightRuns.set('budget-in-flight', inFlightBarrier);
      let destroySettled = false;
      const destroy = runner.onModuleDestroy().then(() => { destroySettled = true; });
      let elapsedMs = 0;

      await jest.advanceTimersByTimeAsync(graceWindowMs - 1);
      elapsedMs += graceWindowMs - 1;
      releaseCollect();
      await run;
      expect(notifyJobComplete).toHaveBeenCalledTimes(1);
      expect(destroySettled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      elapsedMs += 1;
      expect(destroySettled).toBe(false);

      await jest.advanceTimersByTimeAsync(graceWindowMs);
      elapsedMs += graceWindowMs;

      expect(elapsedMs).toBe(2 * graceWindowMs);
      expect(destroySettled).toBe(true);
      await destroy;
      expect(releaseLock).not.toHaveBeenCalled();

      releaseClaim();
      releaseInFlight();
      releaseCleanup();
      await cleanup;
      await Promise.resolve();
      expect(releaseLock).not.toHaveBeenCalled();

      releaseNotification();
      await jest.runAllTimersAsync();
      expect(releaseLock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases the instance lock once on the shutdown fast path', async () => {
    const releaseLock = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
      undefined,
      { release: releaseLock } as unknown as BridgeInstanceLockService,
    );

    await expect(runner.onModuleDestroy()).resolves.toBeUndefined();

    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('treats a rejected captured in-flight run as settled during shutdown', async () => {
    const releaseLock = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
      undefined,
      { release: releaseLock } as unknown as BridgeInstanceLockService,
    );
    const shutdownState = runner as unknown as {
      inFlightRuns: Map<string, Promise<void>>;
    };
    shutdownState.inFlightRuns.set(
      'rejected-run',
      Promise.reject(new Error('in-flight failed')),
    );

    await expect(runner.onModuleDestroy()).resolves.toBeUndefined();

    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('shares one shutdown grace window between pending claims and in-flight runs', async () => {
    jest.useFakeTimers();
    try {
      config.sigkillGraceMs = 1;
      let releaseClaim!: () => void;
      const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
      let releaseRun!: () => void;
      const runBarrier = new Promise<void>((resolve) => { releaseRun = resolve; });
      const releaseLock = jest.fn().mockResolvedValue(undefined);
      const runner = new JobRunnerService(
        repository,
        { execute: jest.fn() } as unknown as OmxExecService,
        mockJobNotify,
        config,
        undefined,
        { release: releaseLock } as unknown as BridgeInstanceLockService,
      );
      const shutdownState = runner as unknown as {
        claimMutex: Promise<void>;
        inFlightRuns: Map<string, Promise<void>>;
      };
      shutdownState.claimMutex = claimBarrier;
      shutdownState.inFlightRuns.set('pending-run', runBarrier);

      const destroy = runner.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(2_002);
      await expect(destroy).resolves.toBeUndefined();

      expect(releaseLock).not.toHaveBeenCalled();

      releaseClaim();
      releaseRun();
      await jest.runAllTimersAsync();

      expect(releaseLock).toHaveBeenCalledTimes(1);
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

  it('uses one full job snapshot for queued and running claim state', async () => {
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );
    await repository.save(createJob());
    const listAll = jest.spyOn(repository, 'listAll');

    const claimed = await (runner as unknown as {
      claimNext: () => Promise<BridgeJob | null>;
    }).claimNext();

    expect(claimed?.id).toBe('00000000-0000-4000-a000-000000000001');
    expect(listAll).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping tmux reconciliation into one collect and one completion', async () => {
    const runningJob = createJob({
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
    });
    await repository.save(runningJob);
    jest.spyOn(repository, 'listByStatus').mockImplementation(async (status) => (
      status === 'running' ? [runningJob] : []
    ));
    const collected = {
      session: {
        ...runningJob.session!,
        status: 'exited' as const,
        updatedAt: '2026-04-02T00:00:02.000Z',
        lastExitCode: 0,
      },
      result: createExecutionResult({ stdout: 'tmux done' }),
    };
    let releaseCollect!: () => void;
    const collectBarrier = new Promise<typeof collected>((resolve) => {
      releaseCollect = () => resolve(collected);
    });
    const collect = jest.fn(() => collectBarrier);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
      { collect } as unknown as TmuxSessionRunnerService,
    );

    const runs = [runner.runOnce(), runner.runOnce(), runner.runOnce()];
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(collect).toHaveBeenCalledTimes(1);
    releaseCollect();
    const runResults = await Promise.all(runs);
    expect(runResults.filter(Boolean)).toHaveLength(1);
    expect(runResults.filter((result) => !result)).toHaveLength(2);
    await expect(repository.getById(runningJob.id)).resolves.toMatchObject({
      status: 'succeeded',
      stdout: 'tmux done',
      session: { status: 'exited', lastExitCode: 0 },
    });
    expect(mockJobNotify.notifyJobComplete).toHaveBeenCalledTimes(1);
  });

  it('clears a rejected tmux reconcile guard so a later pass retries', async () => {
    const listByStatus = jest.spyOn(repository, 'listByStatus')
      .mockRejectedValueOnce(new Error('tmux scan failed'))
      .mockResolvedValue([]);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
      { collect: jest.fn() } as unknown as TmuxSessionRunnerService,
    );
    const reconcile = () => (runner as unknown as {
      reconcileRunningTmuxJobs: () => Promise<number>;
    }).reconcileRunningTmuxJobs();

    const firstOutcomes = await Promise.allSettled([reconcile(), reconcile()]);

    expect(firstOutcomes).toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    expect(listByStatus).toHaveBeenCalledTimes(1);
    await expect(reconcile()).resolves.toBe(0);
    expect(listByStatus).toHaveBeenCalledTimes(2);
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

  it('prepares the tmux state boundary during module initialization', async () => {
    const ensureReady = jest.fn().mockResolvedValue(undefined);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
      { ensureReady, collect: jest.fn().mockResolvedValue(null) } as unknown as TmuxSessionRunnerService,
    );

    try {
      await runner.onModuleInit();
      expect(ensureReady).toHaveBeenCalledTimes(1);
    } finally {
      await runner.onModuleDestroy();
    }
  });

  it('cleans only deleted tmux entries and isolates artifact failures', async () => {
    config.jobRetentionDays = 1;
    const removeArtifacts = jest.fn().mockRejectedValue(new Error('cleanup failed'));
    const cleanupStaleOrphans = jest.fn().mockResolvedValue([]);
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
      { removeArtifacts, cleanupStaleOrphans } as unknown as TmuxSessionRunnerService,
    );
    await repository.save(createJob({
      id: '00000000-0000-4000-a000-000000000001',
      status: 'succeeded',
      executionMode: 'tmux',
      createdAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      session: {
        backend: 'tmux', sessionName: 'owned-session', status: 'exited',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
        attachCommand: 'tmux attach -t owned-session',
      },
    }));
    await repository.save(createJob({
      id: '00000000-0000-4000-a000-000000000002', status: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
    }));

    await expect(runner.cleanupTerminalJobs()).resolves.toBeUndefined();

    expect(removeArtifacts).toHaveBeenCalledTimes(1);
    expect(removeArtifacts).toHaveBeenCalledWith('00000000-0000-4000-a000-000000000001', 'owned-session');
    expect(cleanupStaleOrphans).toHaveBeenCalledTimes(1);
    await expect(repository.getById('00000000-0000-4000-a000-000000000001')).resolves.toBeNull();
    await expect(repository.getById('00000000-0000-4000-a000-000000000002')).resolves.toBeNull();
  });

  it('serializes concurrent cleanup requests', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const cleanupSpy = jest.spyOn(repository, 'cleanupTerminalJobs').mockImplementation(async () => {
      await barrier;
      return { deleted: 0, retained: 0, deletedEntries: [] };
    });
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );

    const first = runner.cleanupTerminalJobs();
    const second = runner.cleanupTerminalJobs();
    release();
    await Promise.all([first, second]);

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('isolates orphan discovery read failures after terminal cleanup', async () => {
    const originalListAll = repository.listAll.bind(repository);
    jest.spyOn(repository, 'listAll')
      .mockImplementationOnce(originalListAll)
      .mockRejectedValueOnce(new Error('durable scan failed'));
    const cleanupStaleOrphans = jest.fn();
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
      { cleanupStaleOrphans } as unknown as TmuxSessionRunnerService,
    );

    await expect(runner.cleanupTerminalJobs()).resolves.toBeUndefined();
    expect(cleanupStaleOrphans).not.toHaveBeenCalled();
  });

  it('isolates durable job-id discovery failures after terminal cleanup', async () => {
    jest.spyOn(repository, 'listDurableJobIds').mockRejectedValueOnce(new Error('durable ids failed'));
    const cleanupStaleOrphans = jest.fn();
    const runner = new JobRunnerService(
      repository, { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify, config,
      { cleanupStaleOrphans } as unknown as TmuxSessionRunnerService,
    );

    await expect(runner.cleanupTerminalJobs()).resolves.toBeUndefined();
    expect(cleanupStaleOrphans).not.toHaveBeenCalled();
  });

  it('waits for an in-flight cleanup during shutdown', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    jest.spyOn(repository, 'cleanupTerminalJobs').mockImplementation(async () => {
      await barrier;
      return { deleted: 0, retained: 0, deletedEntries: [] };
    });
    const runner = new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      mockJobNotify,
      config,
    );
    const cleanup = runner.cleanupTerminalJobs();
    let destroyed = false;
    const destroy = runner.onModuleDestroy().then(() => { destroyed = true; });
    await Promise.resolve();
    expect(destroyed).toBe(false);
    release();
    await Promise.all([cleanup, destroy]);
    expect(destroyed).toBe(true);
  });

  it('retains the instance lock until stuck cleanup settles after shutdown timeout', async () => {
    jest.useFakeTimers();
    try {
      config.sigkillGraceMs = 1;
      let releaseCleanup!: () => void;
      const barrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      jest.spyOn(repository, 'cleanupTerminalJobs').mockImplementation(async () => {
        await barrier;
        return { deleted: 0, retained: 0, deletedEntries: [] };
      });
      const releaseLock = jest.fn().mockResolvedValue(undefined);
      const runner = new JobRunnerService(
        repository, { execute: jest.fn() } as unknown as OmxExecService,
        mockJobNotify, config, undefined,
        { release: releaseLock } as unknown as BridgeInstanceLockService,
      );
      const cleanup = runner.cleanupTerminalJobs();
      const destroy = runner.onModuleDestroy();

      await jest.advanceTimersByTimeAsync(2_002);
      await destroy;
      expect(releaseLock).not.toHaveBeenCalled();
      releaseCleanup();
      await cleanup;
      await jest.runAllTimersAsync();
      expect(releaseLock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['age expiry', 1000, '2000-01-01T00:00:00.000Z'],
    ['max overflow', 0, new Date().toISOString()],
  ])('composes repository %s cleanup with real inactive artifact removal', async (_label, maxTerminalJobs, finishedAt) => {
    config.maxTerminalJobs = maxTerminalJobs;
    config.jobRetentionDays = 7;
    const id = '00000000-0000-4000-a000-000000000041';
    const sessionName = canonicalSessionName(id);
    await repository.save(createJob({
      id, status: 'succeeded', executionMode: 'tmux', finishedAt,
      session: {
        backend: 'tmux', sessionName, status: 'exited', createdAt: finishedAt,
        updatedAt: finishedAt, attachCommand: `tmux attach -t ${sessionName}`,
      },
    }));
    const directory = path.join(config.tmuxSessionsDirectory, id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'session.json'), JSON.stringify({ sessionName }));
    const tmux = new TmuxSessionRunnerService(
      config,
      jest.fn(() => tmuxProbe(1, `can't find session: ${sessionName}`)) as TmuxSpawnFunction,
    );
    const runner = new JobRunnerService(
      repository, { execute: jest.fn() } as unknown as OmxExecService, mockJobNotify, config, tmux,
    );

    await runner.cleanupTerminalJobs();

    await expect(repository.getById(id)).resolves.toBeNull();
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
