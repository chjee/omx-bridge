import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobNotifyService } from '../../src/jobs/job-notify.service';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import { JobRunnerService } from '../../src/jobs/job-runner.service';
import { JobsService } from '../../src/jobs/jobs.service';
import type { BridgeJob, OmxExecutionResult } from '../../src/jobs/job.types';
import type { OmxExecService } from '../../src/jobs/omx-exec.service';
import { createTempDir } from '../helpers';

const ID = '00000000-0000-4000-a000-000000000007';

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = (value) => next(value as T); });
  return { promise, resolve };
}

function config(jobsDirectory: string): BridgeConfig {
  return {
    host: '127.0.0.1', jobsDirectory, omxCommand: 'omx', tmuxCommand: 'tmux',
    tmuxSessionsDirectory: `${jobsDirectory}/sessions`, jobPollIntervalMs: 60_000,
    jobTimeoutMs: 1_000, maxOutputChars: 1_000, sigkillGraceMs: 25,
    maxConcurrency: 1, maxActiveJobs: 50, jobRetentionDays: 7, maxTerminalJobs: 1000,
    jobCleanupIntervalMs: 60_000, notifyTimeoutMs: 1_000, notifyMode: 'openclaw',
    insecureLoopback: false, allowedCwdPrefixes: ['/workspace'],
  };
}

function job(status: BridgeJob['status'] = 'queued'): BridgeJob {
  return {
    id: ID, prompt: 'race', queueOrder: '0000000000001-000001', status,
    createdAt: '2026-07-13T00:00:00.000Z', exitCode: null, stdout: '', stderr: '',
    execution: { command: 'omx', timeoutMs: 1_000, maxOutputChars: 1_000 },
  };
}

function result(): OmxExecutionResult {
  return {
    status: 'succeeded', stdout: 'runner', stderr: '', exitCode: 0,
    execution: { command: 'omx', timeoutMs: 1_000, maxOutputChars: 1_000 },
  };
}

/** Gates calls immediately before JobQueueRepository's real conditional write. */
function gateTransitions(repository: JobQueueRepository) {
  const original = repository.transition.bind(repository);
  const arrivals: Array<ReturnType<typeof deferred>> = [];
  const releases: Array<ReturnType<typeof deferred>> = [];
  const arrivalWaiters: Array<() => void> = [];
  jest.spyOn(repository, 'transition').mockImplementation(async (...args) => {
    const index = arrivals.length;
    arrivals.push(deferred());
    releases.push(deferred());
    arrivals[index].resolve();
    arrivalWaiters[index]?.();
    await releases[index].promise;
    return original(...args);
  });
  return {
    async waitFor(index: number): Promise<void> {
      if (!arrivals[index]) {
        await new Promise<void>((resolve) => { arrivalWaiters[index] = resolve; });
      }
      await arrivals[index]!.promise;
    },
    release(index: number): void { releases[index].resolve(); },
  };
}

describe('conditional transition races', () => {
  let repository: JobQueueRepository;
  let runner: JobRunnerService;
  let service: JobsService;
  let execution: ReturnType<typeof deferred<OmxExecutionResult>>;
  let executionStarted: ReturnType<typeof deferred>;

  beforeEach(async () => {
    const jobsDirectory = await createTempDir('transition-race');
    const bridgeConfig = config(jobsDirectory);
    repository = new JobQueueRepository(bridgeConfig);
    await repository.ensureReady();
    execution = deferred<OmxExecutionResult>();
    executionStarted = deferred();
    const notify = { notifyJobComplete: jest.fn().mockResolvedValue(undefined) } as unknown as JobNotifyService;
    runner = new JobRunnerService(
      repository,
      { execute: jest.fn(() => { executionStarted.resolve(); return execution.promise; }) } as unknown as OmxExecService,
      notify,
      bridgeConfig,
    );
    service = new JobsService(repository, runner, notify, bridgeConfig);
  });

  afterEach(async () => { await runner.onModuleDestroy(); });

  it.each([
    ['claim', 'callback'],
    ['callback', 'claim'],
  ])('serializes claim vs callback when %s reaches the conditional write first', async (winner) => {
    await repository.save(job());
    const gate = gateTransitions(repository);
    const run = runner.runOnce();
    await gate.waitFor(0); // claim is intentionally held before the real repository write.
    const callback = service.completeJobFromCallback(ID, { status: 'succeeded', stdout: 'callback', exitCode: 0 });
    await gate.waitFor(1);

    gate.release(winner === 'claim' ? 0 : 1);
    await Promise.resolve();
    gate.release(winner === 'claim' ? 1 : 0);
    await callback;
    execution.resolve(result());
    if (winner === 'claim') {
      await gate.waitFor(2); // runner completion must also observe the durable callback winner.
      gate.release(2);
    }
    await run;

    await expect(repository.getById(ID)).resolves.toMatchObject({ status: 'succeeded', stdout: 'callback' });
  });

  it.each([
    ['claim', 'cancel'],
    ['cancel', 'claim'],
  ])('serializes claim vs cancel when %s reaches the conditional write first', async (winner) => {
    await repository.save(job());
    const gate = gateTransitions(repository);
    const run = runner.runOnce();
    await gate.waitFor(0);
    const cancel = service.cancelJob(ID);
    await gate.waitFor(1);

    gate.release(winner === 'claim' ? 0 : 1);
    await Promise.resolve();
    gate.release(winner === 'claim' ? 1 : 0);
    await cancel;
    execution.resolve(result());
    if (winner === 'claim') {
      await gate.waitFor(2); // runner completion must also observe the durable cancellation winner.
      gate.release(2);
    }
    await run;

    await expect(repository.getById(ID)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it.each([
    ['runner completion', 'callback'],
    ['callback', 'runner completion'],
  ])('serializes runner completion vs callback when %s reaches the conditional write first', async (winner) => {
    await repository.save(job());
    const gate = gateTransitions(repository);
    const run = runner.runOnce();
    await gate.waitFor(0);
    gate.release(0); // claim
    await executionStarted.promise;
    execution.resolve(result());
    await gate.waitFor(1);
    const callback = service.completeJobFromCallback(ID, { status: 'succeeded', stdout: 'callback', exitCode: 0 });
    await gate.waitFor(2);

    const completionIndex = winner === 'runner completion' ? 1 : 2;
    const callbackIndex = winner === 'runner completion' ? 2 : 1;
    gate.release(completionIndex);
    await Promise.resolve();
    gate.release(callbackIndex);
    await Promise.allSettled([run, callback]);
    await expect(repository.getById(ID)).resolves.toMatchObject({
      status: 'succeeded', stdout: winner === 'runner completion' ? 'runner' : 'callback',
    });
  });

  it.each([
    ['runner completion', 'cancel'],
    ['cancel', 'runner completion'],
  ])('serializes runner completion vs cancel when %s reaches the conditional write first', async (winner) => {
    await repository.save(job());
    const gate = gateTransitions(repository);
    const run = runner.runOnce();
    await gate.waitFor(0);
    gate.release(0);
    await executionStarted.promise;
    execution.resolve(result());
    await gate.waitFor(1);
    const cancel = service.cancelJob(ID);
    await gate.waitFor(2);

    gate.release(winner === 'runner completion' ? 1 : 2);
    await Promise.resolve();
    gate.release(winner === 'runner completion' ? 2 : 1);
    await Promise.allSettled([run, cancel]);
    await expect(repository.getById(ID)).resolves.toMatchObject({
      status: winner === 'runner completion' ? 'succeeded' : 'cancelled',
    });
  });
});
