import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppModule } from '../src/app.module';
import { JobRunnerService } from '../src/jobs/job-runner.service';
import { JobsController } from '../src/jobs/jobs.controller';
import { OmxExecService } from '../src/jobs/omx-exec.service';
import { TelegramNotifyService } from '../src/jobs/telegram-notify.service';
import type { BridgeJob, OmxExecutionResult } from '../src/jobs/job.types';
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

describe('Jobs API (e2e)', () => {
  let app: INestApplication;
  let jobsDirectory: string;
  let fakeOmxExecService: FakeOmxExecService;
  let runner: JobRunnerService;
  let controller: JobsController;
  let notifyJobComplete: jest.Mock;

  async function getJob(jobId: string): Promise<BridgeJob> {
    return controller.getJob(jobId);
  }

  beforeEach(async () => {
    jobsDirectory = await createTempDir('bridge-e2e');
    process.env.BRIDGE_JOBS_DIR = jobsDirectory;
    process.env.BRIDGE_JOB_POLL_INTERVAL_MS = '1000';
    fakeOmxExecService = new FakeOmxExecService();
    notifyJobComplete = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OmxExecService)
      .useValue(fakeOmxExecService)
      .overrideProvider(TelegramNotifyService)
      .useValue({ notifyJobComplete })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    runner = app.get(JobRunnerService);
    controller = app.get(JobsController);
  });

  afterEach(async () => {
    await app.close();
    delete process.env.BRIDGE_JOBS_DIR;
    delete process.env.BRIDGE_JOB_POLL_INTERVAL_MS;
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
    const queuedResponse = await controller.createJob({ prompt: 'queued only' });
    const finishedResponse = await controller.createJob({ prompt: 'run me' });

    await runner.runOnce();

    const listResponse = await controller.listJobs({});
    expect(listResponse.map((job: BridgeJob) => job.id)).toEqual([
      queuedResponse.jobId,
      finishedResponse.jobId,
    ]);

    const succeededResponse = await controller.listJobs({ status: 'succeeded' });
    expect(succeededResponse).toHaveLength(1);
    expect(succeededResponse[0]).toMatchObject({
      id: queuedResponse.jobId,
      status: 'succeeded',
    });
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

prompt="\${@: -1}"
printf 'omx:%s\n' "$prompt" >> "$BRIDGE_TRACE_FILE"
exec node "$FAKE_CODEX_PATH" "$prompt"
`,
      'utf8',
    );
    await fs.chmod(fakeOmxPath, 0o755);

    process.env.BRIDGE_JOBS_DIR = jobsDirectory;
    process.env.BRIDGE_JOB_POLL_INTERVAL_MS = '1000';
    process.env.BRIDGE_JOB_TIMEOUT_MS = '5000';
    process.env.OMX_COMMAND = fakeOmxPath;
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
    delete process.env.OMX_COMMAND;
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

    const trace = await fs.readFile(traceFile, 'utf8');
    expect(trace.trim().split(os.EOL)).toEqual([
      'omx:Andy asks Codex for bridge verification',
      'codex:Andy asks Codex for bridge verification',
    ]);
  });
});
