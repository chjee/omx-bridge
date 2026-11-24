import { EventEmitter } from 'node:events';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobNotifyService } from '../../src/jobs/job-notify.service';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import { JobRunnerService } from '../../src/jobs/job-runner.service';
import { JobsService } from '../../src/jobs/jobs.service';
import type { BridgeJob } from '../../src/jobs/job.types';
import type { OmxExecService } from '../../src/jobs/omx-exec.service';
import { TmuxSessionRunnerService, type TmuxSpawnFunction } from '../../src/jobs/tmux-session-runner.service';
import { createTempDir, waitFor } from '../helpers';

const JOB_ID = '00000000-0000-4000-a000-000000000091';

function sessionName(): string {
  return `omx-bridge-${JOB_ID.replace(/-/g, '').slice(0, 24)}`;
}

function pendingPath(config: BridgeConfig): string {
  return path.join(config.tmuxSessionsDirectory, JOB_ID, 'cleanup-pending.json');
}

function createConfig(root: string): BridgeConfig {
  return {
    host: '127.0.0.1',
    jobsDirectory: path.join(root, 'jobs'),
    omxCommand: 'omx',
    tmuxCommand: 'tmux',
    tmuxSessionsDirectory: path.join(root, 'sessions'),
    jobPollIntervalMs: 60_000,
    jobTimeoutMs: 60_000,
    maxOutputChars: 1_000,
    sigkillGraceMs: 1,
    maxConcurrency: 1,
    maxActiveJobs: 50,
    jobRetentionDays: 7,
    maxTerminalJobs: 1_000,
    jobCleanupIntervalMs: 60_000,
    notifyTimeoutMs: 1_000,
    notifyMode: 'openclaw',
    insecureLoopback: false,
    allowedCwdPrefixes: [root],
    omxEnvAllowlist: ['PATH'],
  };
}

function job(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: JOB_ID,
    prompt: 'recover this session',
    executionMode: 'tmux',
    queueOrder: '0000000000001-000001',
    status: 'queued',
    createdAt: new Date().toISOString(),
    exitCode: null,
    stdout: '',
    stderr: '',
    execution: { command: 'omx', timeoutMs: 60_000, maxOutputChars: 1_000 },
    ...overrides,
  };
}

class MockChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn(() => true);
}

type Liveness = 'present' | 'missing' | 'unknown';

class StatefulTmux {
  readonly sessions = new Set<string>();
  readonly calls: string[][] = [];
  newSessionResult: 'success' | 'fail' = 'success';
  killResult: 'success' | 'fail' = 'success';
  liveness: Liveness = 'missing';
  holdNewSession = false;
  pendingObservedAtNewSession = false;
  pendingPayloadAtNewSession: unknown;
  constructor(private readonly markerPath: string) {}
  private releaseNewSession?: () => void;

  readonly spawn: TmuxSpawnFunction = ((_command, args = []) => {
    this.calls.push([...args]);
    const child = new MockChild();
    const complete = (code: number | null, stderr = '') => {
      setImmediate(() => {
        if (stderr) child.stderr.write(stderr);
        child.emit('close', code);
      });
    };
    const command = args[0];
    const name = (args[args.indexOf('-t') + 1] ?? args.at(-1) ?? '').replace(/^=/, '');

    if (command === 'new-session') {
      const sessionIndex = args.indexOf('-s');
      const requested = args[sessionIndex + 1]!;
      this.pendingObservedAtNewSession = existsSync(this.markerPath);
      this.pendingPayloadAtNewSession = this.pendingObservedAtNewSession
        ? JSON.parse(readFileSync(this.markerPath, 'utf8'))
        : undefined;
      const close = () => {
        if (this.newSessionResult === 'success') {
          this.sessions.add(requested);
          complete(0);
        } else {
          complete(1, 'new session failed');
        }
      };
      if (this.holdNewSession) {
        this.releaseNewSession = close;
      } else {
        close();
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    if (command === 'kill-session') {
      const requested = name!;
      if (this.killResult === 'success') {
        this.sessions.delete(requested);
        complete(0);
      } else {
        complete(1, 'kill failed');
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    if (command === 'has-session') {
      const requested = name!;
      if (this.liveness === 'unknown') {
        complete(null, 'tmux unavailable');
      } else if (this.liveness === 'present' || this.sessions.has(requested)) {
        complete(0);
      } else {
        complete(1, `can't find session: ${requested}`);
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    complete(0);
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as TmuxSpawnFunction;

  releaseStart(): void {
    this.releaseNewSession?.();
    this.releaseNewSession = undefined;
  }

  count(command: string): number {
    return this.calls.filter((args) => args[0] === command).length;
  }
}

function createRunner(
  repository: JobQueueRepository,
  config: BridgeConfig,
  tmux: StatefulTmux,
  notifyJobComplete: JobNotifyService['notifyJobComplete'],
): JobRunnerService {
  return new JobRunnerService(
    repository,
    { execute: jest.fn() } as unknown as OmxExecService,
    { notifyJobComplete } as unknown as JobNotifyService,
    config,
    new TmuxSessionRunnerService(config, tmux.spawn),
  );
}

describe('tmux start recovery', () => {
  const roots: string[] = [];
  const runners: JobRunnerService[] = [];
  const tmuxes: StatefulTmux[] = [];

  async function fixture(prefix: string): Promise<{
    config: BridgeConfig;
    repository: JobQueueRepository;
    tmux: StatefulTmux;
  }> {
    const root = await createTempDir(prefix);
    roots.push(root);
    const config = createConfig(root);
    const repository = new JobQueueRepository(config);
    await repository.ensureReady();
    const tmux = new StatefulTmux(pendingPath(config));
    tmuxes.push(tmux);
    return { config, repository, tmux };
  }

  function track(runner: JobRunnerService): JobRunnerService {
    runners.push(runner);
    return runner;
  }

  beforeEach(() => {
    roots.splice(0);
    runners.splice(0);
    tmuxes.splice(0);
  });

  afterEach(async () => {
    for (const tmux of tmuxes) tmux.releaseStart();
    await Promise.allSettled(runners.map((runner) => runner.onModuleDestroy()));
    await Promise.allSettled(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it.each([
    ['cancellation', async (service: JobsService) => service.cancelJob(JOB_ID), 'cancelled'],
    ['callback completion', async (service: JobsService) => service.completeJobFromCallback(
      JOB_ID,
      { status: 'succeeded', stdout: 'callback', exitCode: 0 },
    ), 'succeeded'],
  ] as const)('reclaims a session when %s wins while tmux startup is pending', async (
    _winner,
    complete,
    expectedStatus,
  ) => {
    const { config, repository, tmux } = await fixture('tmux-start-cancel');
    await repository.save(job());
    tmux.holdNewSession = true;
    const notifyJobComplete = jest.fn().mockResolvedValue(undefined);
    const runner = track(createRunner(repository, config, tmux, notifyJobComplete));
    const service = new JobsService(repository, runner, { notifyJobComplete } as unknown as JobNotifyService, config);

    const run = runner.runOnce();
    await waitFor(() => Promise.resolve(tmux.calls.length), (count) => count === 1);
    expect(tmux.pendingObservedAtNewSession).toBe(true);
    expect(tmux.pendingPayloadAtNewSession).toEqual({ jobId: JOB_ID, sessionName: sessionName() });
    await complete(service);
    tmux.releaseStart();
    await run;

    expect(tmux.sessions).toEqual(new Set());
    await expect(repository.getById(JOB_ID)).resolves.toMatchObject({
      status: expectedStatus,
      ...(_winner === 'callback completion' ? { stdout: 'callback', exitCode: 0 } : {}),
    });
    await waitFor(() => Promise.resolve(notifyJobComplete.mock.calls.length), (count) => count === 1);
  });

  it('reclaims a started session after saving its job session throws', async () => {
    const { config, repository, tmux } = await fixture('tmux-start-save-error');
    await repository.save(job());
    const transition = jest.spyOn(repository, 'transition');
    transition.mockImplementationOnce(transition.getMockImplementation()!);
    transition.mockRejectedValueOnce(new Error('session persistence failed'));
    const notifyJobComplete = jest.fn().mockResolvedValue(undefined);
    const runner = track(createRunner(repository, config, tmux, notifyJobComplete));

    await runner.runOnce();

    expect(tmux.sessions).toEqual(new Set());
    await expect(repository.getById(JOB_ID)).resolves.toMatchObject({
      status: 'failed',
      execution: { errorType: 'execution_error' },
    });
    await waitFor(() => Promise.resolve(notifyJobComplete.mock.calls.length), (count) => count === 1);
  });

  it('reclaims pending terminal-session cleanup after a service restart without notifying again', async () => {
    const { config, repository, tmux } = await fixture('tmux-start-restart');
    await repository.save(job());
    tmux.killResult = 'fail';
    tmux.holdNewSession = true;
    const notify = new JobNotifyService(config, repository);
    const notifyJobComplete = jest.spyOn(notify, 'notifyJobComplete');
    const firstRunner = track(new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      notify,
      config,
      new TmuxSessionRunnerService(config, tmux.spawn),
    ));
    const service = new JobsService(repository, firstRunner, notify, config);
    const run = firstRunner.runOnce();
    await waitFor(() => Promise.resolve(tmux.count('new-session')), (count) => count === 1);
    await service.cancelJob(JOB_ID);
    tmux.releaseStart();
    await run;
    const terminal = await waitFor(
      () => repository.getById(JOB_ID),
      (value) => value?.status === 'cancelled' && Boolean(value.notifyOutcome),
    );
    expect(terminal).not.toBeNull();
    expect(terminal?.notifyHistory).toHaveLength(1);
    await expect(fs.readFile(pendingPath(config), 'utf8')).resolves.toContain(sessionName());
    expect(tmux.sessions).toEqual(new Set([sessionName()]));
    expect(tmux.count('kill-session')).toBeGreaterThanOrEqual(1);
    await firstRunner.onModuleDestroy();
    tmux.killResult = 'success';

    const killsBeforeRestart = tmux.count('kill-session');
    const restartedRepository = new JobQueueRepository(config);
    const restartedNotify = new JobNotifyService(config, restartedRepository);
    const restartedNotifyJobComplete = jest.spyOn(restartedNotify, 'notifyJobComplete');
    const restarted = track(createRunner(
      restartedRepository,
      config,
      tmux,
      restartedNotify.notifyJobComplete.bind(restartedNotify),
    ));
    await restarted.onModuleInit();
    await restarted.onModuleDestroy();
    const killsAfterRecovery = tmux.count('kill-session');
    const secondRepository = new JobQueueRepository(config);
    const secondNotify = new JobNotifyService(config, secondRepository);
    const secondRestart = track(createRunner(
      secondRepository,
      config,
      tmux,
      secondNotify.notifyJobComplete.bind(secondNotify),
    ));
    await secondRestart.onModuleInit();
    await secondRestart.onModuleDestroy();

    expect(tmux.sessions).toEqual(new Set());
    await expect(fs.access(pendingPath(config))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(repository.getById(JOB_ID)).resolves.toEqual(terminal);
    expect(notifyJobComplete).toHaveBeenCalledTimes(1);
    expect(killsAfterRecovery).toBe(killsBeforeRestart + 1);
    expect(tmux.count('kill-session')).toBe(killsAfterRecovery);
  });

  it('clears a stale pending record without stopping a session already attached to its running job', async () => {
    const { config, repository, tmux } = await fixture('tmux-start-stale-pending');
    const running = job({
      status: 'running',
      startedAt: new Date().toISOString(),
      session: {
        backend: 'tmux', sessionName: sessionName(), status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        attachCommand: `tmux attach -t ${sessionName()}`,
      },
    });
    await repository.save(running);
    const directory = path.dirname(pendingPath(config));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(pendingPath(config), JSON.stringify({ jobId: JOB_ID, sessionName: sessionName() }), { mode: 0o600 });
    tmux.sessions.add(sessionName());
    const notifyJobComplete = jest.fn().mockResolvedValue(undefined);
    const runner = track(createRunner(repository, config, tmux, notifyJobComplete));

    await runner.onModuleInit();
    await runner.onModuleDestroy();

    expect(tmux.sessions).toEqual(new Set([sessionName()]));
    expect(tmux.count('kill-session')).toBe(0);
    await expect(fs.access(pendingPath(config))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes pending state when failed new-session is confirmed absent', async () => {
    const { config, repository, tmux } = await fixture('tmux-start-new-session-failure');
    await repository.save(job());
    tmux.newSessionResult = 'fail';
    tmux.liveness = 'missing';
    const notifyJobComplete = jest.fn().mockResolvedValue(undefined);
    const runner = track(createRunner(repository, config, tmux, notifyJobComplete));

    await runner.runOnce();

    expect(tmux.pendingObservedAtNewSession).toBe(true);
    await expect(repository.getById(JOB_ID)).resolves.toMatchObject({ status: 'failed' });
    await expect(fs.access(pendingPath(config))).rejects.toMatchObject({ code: 'ENOENT' });
    await waitFor(() => Promise.resolve(notifyJobComplete.mock.calls.length), (count) => count === 1);
  });

  it('retains failed new-session pending state until a restart confirms the session is absent', async () => {
    const { config, repository, tmux } = await fixture('tmux-start-new-session-unknown');
    await repository.save(job());
    tmux.newSessionResult = 'fail';
    tmux.liveness = 'unknown';
    const notify = new JobNotifyService(config, repository);
    const notifyJobComplete = jest.spyOn(notify, 'notifyJobComplete');
    const first = track(new JobRunnerService(
      repository,
      { execute: jest.fn() } as unknown as OmxExecService,
      notify,
      config,
      new TmuxSessionRunnerService(config, tmux.spawn),
    ));

    await first.runOnce();

    expect(tmux.pendingObservedAtNewSession).toBe(true);
    await expect(repository.getById(JOB_ID)).resolves.toMatchObject({ status: 'running' });
    await expect(fs.readFile(pendingPath(config), 'utf8')).resolves.toContain(sessionName());
    await first.onModuleDestroy();
    tmux.liveness = 'missing';

    const restartedRepository = new JobQueueRepository(config);
    const restartedNotify = new JobNotifyService(config, restartedRepository);
    const restartedNotifyJobComplete = jest.spyOn(restartedNotify, 'notifyJobComplete');
    const restarted = track(new JobRunnerService(
      restartedRepository,
      { execute: jest.fn() } as unknown as OmxExecService,
      restartedNotify,
      config,
      new TmuxSessionRunnerService(config, tmux.spawn),
    ));
    await restarted.onModuleInit();
    await waitFor(() => Promise.resolve(restartedNotifyJobComplete.mock.calls.length), (count) => count === 1);
    await restarted.onModuleDestroy();

    await expect(repository.getById(JOB_ID)).resolves.toMatchObject({ status: 'failed' });
    await expect(fs.access(pendingPath(config))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(notifyJobComplete).not.toHaveBeenCalled();
    expect(restartedNotifyJobComplete).toHaveBeenCalledTimes(1);
  });
});
