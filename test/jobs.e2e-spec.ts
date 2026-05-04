import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppModule } from '../src/app.module';
import { JobRunnerService } from '../src/jobs/job-runner.service';
import { JobsController } from '../src/jobs/jobs.controller';
import { OmxExecService } from '../src/jobs/omx-exec.service';
import { JobNotifyService } from '../src/jobs/job-notify.service';
import { JobQueueRepository } from '../src/jobs/job-queue.repository';
import type { BridgeJob, OmxExecutionResult } from '../src/jobs/job.types';
import { TmuxSessionRunnerService } from '../src/jobs/tmux-session-runner.service';
import { createTempDir, waitFor } from './helpers';

class FakeOmxExecService {
  public readonly calls: string[] = [];
  public maxConcurrent = 0;
  private activeCount = 0;
  private readonly pendingSignals = new Set<AbortSignal>();

  async execute(
    prompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<OmxExecutionResult> {
    this.calls.push(prompt);
    this.activeCount += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.activeCount);

    if (prompt.includes('wait')) {
      const signal = options?.signal;
      if (!signal) {
        throw new Error('Expected abort signal for wait prompt');
      }

      this.pendingSignals.add(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      this.pendingSignals.delete(signal);
      this.activeCount -= 1;
      return {
        status: 'cancelled',
        stdout: '',
        stderr: 'Command cancelled',
        exitCode: null,
        execution: {
          command: 'fake-omx',
          timeoutMs: 50,
          maxOutputChars: 500,
          errorType: 'cancelled',
        },
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 25));

    this.activeCount -= 1;
    if (prompt.includes('fail')) {
      return {
        status: 'failed',
        stdout: '',
        stderr: `failed:${prompt}`,
        exitCode: 1,
        execution: {
          command: 'fake-omx',
          timeoutMs: 50,
          maxOutputChars: 500,
          errorType: 'non_zero_exit',
        },
      };
    }

    return {
      status: 'succeeded',
      stdout: `done:${prompt}`,
      stderr: '',
      exitCode: 0,
      execution: {
        command: 'fake-omx',
        timeoutMs: 50,
        maxOutputChars: 500,
      },
    };
  }
}

class FakeTmuxSessionRunnerService {
  public readonly startedJobIds: string[] = [];

  async start(job: BridgeJob): Promise<NonNullable<BridgeJob['session']>> {
    this.startedJobIds.push(job.id);
    return {
      backend: 'tmux',
      sessionName: `fake-${job.id.slice(0, 8)}`,
      status: 'running',
      createdAt: job.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attachCommand: `tmux attach -t fake-${job.id.slice(0, 8)}`,
      ...(job.cwd ? { cwd: job.cwd } : {}),
    };
  }

  async collect(): Promise<null> {
    return null;
  }

  async cancel(job: BridgeJob): Promise<NonNullable<BridgeJob['session']> | null> {
    if (!job.session) {
      return null;
    }
    return {
      ...job.session,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    };
  }
}

function createBridgeJobFixture(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? '00000000-0000-4000-a000-000000000001',
    prompt: overrides.prompt ?? 'fixture job',
    cwd: overrides.cwd,
    queueOrder: overrides.queueOrder ?? '0000000000001-000001',
    requestId: overrides.requestId,
    originRoutingKey: overrides.originRoutingKey,
    source: overrides.source,
    sourceName: overrides.sourceName,
    metadata: overrides.metadata,
    notifyUrl: overrides.notifyUrl,
    status: overrides.status ?? 'queued',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt,
    exitCode: overrides.exitCode ?? null,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    execution: overrides.execution ?? {
      command: 'fake-omx',
      timeoutMs: 50,
      maxOutputChars: 500,
    },
    notifyOutcome: overrides.notifyOutcome,
    notifyHistory: overrides.notifyHistory,
  };
}

describe('Jobs API (e2e)', () => {
  let app: INestApplication;
  let jobsDirectory: string;
  let fakeOmxExecService: FakeOmxExecService;
  let fakeTmuxSessionRunner: FakeTmuxSessionRunnerService;
  let runner: JobRunnerService;
  let controller: JobsController;
  let repository: JobQueueRepository;
  let notifyJobComplete: jest.Mock;

  async function getJob(jobId: string): Promise<BridgeJob> {
    return controller.getJob(jobId);
  }

  beforeEach(async () => {
    jobsDirectory = await createTempDir('bridge-e2e');
    process.env.BRIDGE_JOBS_DIR = jobsDirectory;
    process.env.BRIDGE_JOB_POLL_INTERVAL_MS = '1000';
    process.env.BRIDGE_MAX_CONCURRENCY = '1';
    process.env.BRIDGE_API_TOKEN = '';
    fakeOmxExecService = new FakeOmxExecService();
    fakeTmuxSessionRunner = new FakeTmuxSessionRunnerService();
    notifyJobComplete = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OmxExecService)
      .useValue(fakeOmxExecService)
      .overrideProvider(TmuxSessionRunnerService)
      .useValue(fakeTmuxSessionRunner)
      .overrideProvider(JobNotifyService)
      .useValue({ notifyJobComplete })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    runner = app.get(JobRunnerService);
    controller = app.get(JobsController);
    repository = app.get(JobQueueRepository);
    notifyJobComplete.mockImplementation(
      async (job: BridgeJob, options?: { trigger?: 'auto' | 'manual' }) => {
        const latest = await repository.getById(job.id);
        if (!latest) return undefined;
        const outcome = {
          attemptedAt: new Date().toISOString(),
          mode: 'openclaw' as const,
          trigger: options?.trigger ?? 'auto',
          attemptIndex: latest.notifyHistory?.length ?? 0,
          openclaw: { status: 'skipped' as const, skippedReason: 'not_configured' },
          telegram: { status: 'skipped' as const, skippedReason: 'not_configured' },
        };
        await repository.save({
          ...latest,
          notifyOutcome: outcome,
          notifyHistory: [...(latest.notifyHistory ?? []), outcome].slice(-10),
        });
        return outcome;
      },
    );
  });

  afterEach(async () => {
    await app.close();
    delete process.env.BRIDGE_JOBS_DIR;
    delete process.env.BRIDGE_JOB_POLL_INTERVAL_MS;
    delete process.env.BRIDGE_MAX_CONCURRENCY;
    delete process.env.BRIDGE_API_TOKEN;
  });

  it('submits, persists, executes, and returns a successful job', async () => {
    const createResponse = await controller.createJob({
      prompt: 'hello bridge',
      requestId: 'req-1',
    });

    const { jobId } = createResponse;
    await expect(fs.stat(path.join(jobsDirectory, `${jobId}.json`))).resolves.toBeDefined();
    await runner.runOnce();

    const job = await waitFor(
      () => getJob(jobId),
      (currentJob) => currentJob.status === 'succeeded',
    );

    expect(job).toMatchObject({
      id: jobId,
      prompt: 'hello bridge',
      status: 'succeeded',
      stdout: 'done:hello bridge',
      exitCode: 0,
    });
  });

  it('surfaces failed omx executions without crashing the bridge', async () => {
    const failResponse = await controller.createJob({ prompt: 'please fail' });
    await runner.runOnce();

    const failedJob = await waitFor(
      () => getJob(failResponse.jobId),
      (job) => job.status === 'failed',
    );

    expect(failedJob.stderr).toContain('failed:please fail');
    expect(failedJob.exitCode).toBe(1);

    await controller.createJob({ prompt: 'still alive' });
    await runner.runOnce();
  });

  it('accepts tmux execution mode and starts a session-backed job without exec', async () => {
    const response = await controller.createJob({
      prompt: 'long running tmux work',
      executionMode: 'tmux',
    });

    const job = await waitFor(
      () => repository.getById(response.jobId),
      (currentJob) => currentJob?.status === 'running' && currentJob.session?.status === 'running',
    );
    expect(job).toMatchObject({
      id: response.jobId,
      executionMode: 'tmux',
      status: 'running',
      session: {
        backend: 'tmux',
        status: 'running',
      },
    });
    expect(fakeOmxExecService.calls).toEqual([]);
    expect(fakeTmuxSessionRunner.startedJobIds).toContain(response.jobId);
  });

  it('returns compact session details for tmux and exec jobs', async () => {
    const tmuxResponse = await controller.createJob({
      prompt: 'inspect tmux session',
      executionMode: 'tmux',
    });
    await waitFor(
      () => repository.getById(tmuxResponse.jobId),
      (currentJob) => currentJob?.status === 'running' && currentJob.session?.status === 'running',
    );

    await expect(controller.getJobSession(tmuxResponse.jobId)).resolves.toMatchObject({
      jobId: tmuxResponse.jobId,
      jobStatus: 'running',
      executionMode: 'tmux',
      attachCommand: expect.stringContaining('tmux attach -t fake-'),
      session: {
        backend: 'tmux',
        status: 'running',
      },
    });

    const execResponse = await controller.createJob({ prompt: 'inspect exec job' });
    await expect(controller.getJobSession(execResponse.jobId)).resolves.toEqual({
      jobId: execResponse.jobId,
      jobStatus: 'queued',
      executionMode: 'exec',
      attachCommand: null,
      session: null,
    });
  });

  it('processes jobs in FIFO order with only one running at a time', async () => {
    const submissions = [];
    for (const prompt of ['first', 'second', 'third']) {
      submissions.push(await controller.createJob({ prompt }));
    }

    const jobIds = submissions.map((response) => response.jobId);
    await runner.runOnce();
    await runner.runOnce();
    await runner.runOnce();
    await waitFor(
      async () => Promise.all(jobIds.map((jobId) => getJob(jobId))),
      (jobs) => jobs.every((job) => job.status === 'succeeded'),
      5_000,
    );

    expect(fakeOmxExecService.calls).toEqual(['first', 'second', 'third']);
    expect(fakeOmxExecService.maxConcurrent).toBe(1);
  });

  it('lists all jobs and supports filtering by status', async () => {
    const firstJob = await controller.createJob({ prompt: 'run first' });
    const secondJob = await controller.createJob({ prompt: 'queued second' });

    await waitFor(
      async () => Promise.all([getJob(firstJob.jobId), getJob(secondJob.jobId)]),
      (jobs) => jobs.every((job) => job.status === 'succeeded'),
      5_000,
    );

    const listResponse = await controller.listJobs({});
    expect(listResponse.map((job: BridgeJob) => job.id)).toEqual([
      firstJob.jobId,
      secondJob.jobId,
    ]);

    const succeededJobs = await controller.listJobs({ status: 'succeeded' });
    expect(succeededJobs).toHaveLength(2);
    expect(succeededJobs[0]).toMatchObject({
      id: firstJob.jobId,
      status: 'succeeded',
    });
  });

  it('returns job stats from the stats route handler', async () => {
    await repository.save(createBridgeJobFixture({
      id: '00000000-0000-4000-a000-000000000103',
      status: 'queued',
      createdAt: new Date(Date.now() - 1_000).toISOString(),
    }));

    const response = await controller.getStats();

    expect(response).toMatchObject({
      queuedCount: 1,
      runningCount: 0,
      activeCount: 1,
      terminalCount: 0,
      maxConcurrency: 1,
    });
    expect(response).toHaveProperty('maxActiveJobs');
    expect(response.oldestQueuedAgeMs).not.toBeNull();
  });

  it('manually retries notification for terminal jobs from the retry route handler', async () => {
    const terminalJob = createBridgeJobFixture({
      id: '00000000-0000-4000-a000-000000000101',
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      stdout: 'done',
    });
    await repository.save(terminalJob);

    const response = await controller.retryNotify(terminalJob.id);

    expect(response).toMatchObject({
      id: terminalJob.id,
      prompt: terminalJob.prompt,
      status: 'succeeded',
    });
    expect(response.notifyHistory).toHaveLength(1);
    expect(response.notifyHistory?.[0]).toMatchObject({
      trigger: 'manual',
      attemptIndex: 0,
    });
    expect(notifyJobComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: terminalJob.id }),
      { trigger: 'manual' },
    );
  });

  it('rejects manual notification retry for queued jobs from the retry route handler', async () => {
    const queuedJob = createBridgeJobFixture({
      id: '00000000-0000-4000-a000-000000000102',
      status: 'queued',
    });
    await repository.save(queuedJob);

    await expect(controller.retryNotify(queuedJob.id)).rejects.toThrow(ConflictException);
  });

  it('accepts webhook callbacks and finalizes queued jobs without executing OMX', async () => {
    const createResponse = await controller.createJob({ prompt: 'callback job' });

    const callbackResponse = await controller.handleJobCallback(createResponse.jobId, {
      status: 'succeeded',
      stdout: 'callback result',
      exitCode: 0,
      execution: {
        durationMs: 12,
      },
    });

    expect(callbackResponse).toMatchObject({
      id: createResponse.jobId,
      status: 'succeeded',
      stdout: 'callback result',
      exitCode: 0,
    });
    expect(fakeOmxExecService.calls).toEqual([]);
    expect(notifyJobComplete).toHaveBeenCalledTimes(1);
    expect(notifyJobComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        id: createResponse.jobId,
        status: 'succeeded',
        stdout: 'callback result',
      }),
    );
  });

  it('cancels queued and running jobs', async () => {
    const queuedResponse = await controller.createJob({ prompt: 'queued cancel' });

    const queuedCancel = await controller.cancelJob(queuedResponse.jobId);
    expect(queuedCancel).toMatchObject({
      id: queuedResponse.jobId,
      status: 'cancelled',
    });

    const runningResponse = await controller.createJob({ prompt: 'wait for cancel' });

    const runPromise = runner.runOnce();
    await waitFor(
      () => getJob(runningResponse.jobId),
      (job) => job.status === 'running',
    );

    const runningCancel = await controller.cancelJob(runningResponse.jobId);
    expect(runningCancel).toMatchObject({
      id: runningResponse.jobId,
      status: 'cancelled',
    });
    await runPromise;

    const cancelledJob = await getJob(runningResponse.jobId);
    expect(cancelledJob).toMatchObject({
      status: 'cancelled',
    });
    expect(cancelledJob.stderr).toContain('Cancelled by API request');
  });
});

describe('Jobs API real OMX -> Codex chain (e2e)', () => {
  let app: INestApplication;
  let jobsDirectory: string;
  let runner: JobRunnerService;
  let controller: JobsController;
  let traceFile: string;
  let fakeOmxPath: string;
  let fakeCodexPath: string;

  beforeEach(async () => {
    jobsDirectory = await createTempDir('bridge-real-e2e');
    traceFile = path.join(jobsDirectory, 'trace.log');
    fakeCodexPath = path.join(jobsDirectory, 'fake-codex.mjs');
    fakeOmxPath = path.join(jobsDirectory, 'fake-omx.sh');

    await fs.writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const prompt = process.argv[2] ?? '';
appendFileSync(process.env.BRIDGE_TRACE_FILE, \`codex:\${prompt}\\n\`);
console.log(\`codex-result:\${prompt}\`);
`,
      'utf8',
    );
    await fs.chmod(fakeCodexPath, 0o755);

    await fs.writeFile(
      fakeOmxPath,
      `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1-}" != "exec" ]; then
  echo "unsupported omx command: \${1-}" >&2
  exit 64
fi

if [ "\${@: -1}" != "-" ]; then
  echo "expected stdin prompt marker" >&2
  exit 64
fi

prompt="$(cat)"
printf 'omx:%s\n' "$prompt" >> "$BRIDGE_TRACE_FILE"
exec node "$FAKE_CODEX_PATH" "$prompt"
`,
      'utf8',
    );
    await fs.chmod(fakeOmxPath, 0o755);

    process.env.BRIDGE_JOBS_DIR = jobsDirectory;
    process.env.BRIDGE_JOB_POLL_INTERVAL_MS = '1000';
    process.env.BRIDGE_JOB_TIMEOUT_MS = '5000';
    process.env.BRIDGE_MAX_CONCURRENCY = '1';
    process.env.BRIDGE_API_TOKEN = '';
    process.env.OMX_COMMAND = fakeOmxPath;
    process.env.BRIDGE_OMX_ENV_ALLOWLIST = 'PATH,BRIDGE_TRACE_FILE,FAKE_CODEX_PATH';
    process.env.BRIDGE_TRACE_FILE = traceFile;
    process.env.FAKE_CODEX_PATH = fakeCodexPath;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    runner = app.get(JobRunnerService);
    controller = app.get(JobsController);
  });

  afterEach(async () => {
    await app.close();
    delete process.env.BRIDGE_JOBS_DIR;
    delete process.env.BRIDGE_JOB_POLL_INTERVAL_MS;
    delete process.env.BRIDGE_JOB_TIMEOUT_MS;
    delete process.env.BRIDGE_MAX_CONCURRENCY;
    delete process.env.BRIDGE_API_TOKEN;
    delete process.env.OMX_COMMAND;
    delete process.env.BRIDGE_OMX_ENV_ALLOWLIST;
    delete process.env.BRIDGE_TRACE_FILE;
    delete process.env.FAKE_CODEX_PATH;
  });

  it('accepts an Andy-side job payload, runs OMX, and completes through Codex output', async () => {
    const createResponse = await controller.createJob({
      prompt: 'Andy asks Codex for bridge verification',
      requestId: 'andy-e2e-1',
      metadata: {
        source: 'andy',
      },
    });

    const { jobId } = createResponse;
    await runner.runOnce();

    const job = await waitFor(
      () => controller.getJob(jobId),
      (currentJob) => currentJob.status === 'succeeded',
      5_000,
    );

    expect(job).toMatchObject({
      id: jobId,
      prompt: 'Andy asks Codex for bridge verification',
      requestId: 'andy-e2e-1',
      metadata: {
        source: 'andy',
      },
      status: 'succeeded',
      stderr: '',
      exitCode: 0,
      execution: {
        command: fakeOmxPath,
      },
    });

    await waitFor(
      () => controller.getJob(jobId),
      (currentJob) => currentJob.notifyOutcome !== undefined,
      5_000,
    );

    const trace = await fs.readFile(traceFile, 'utf8');
    expect(trace.trim().split(os.EOL)).toEqual([
      'omx:Andy asks Codex for bridge verification',
      'codex:Andy asks Codex for bridge verification',
    ]);
  });
});
