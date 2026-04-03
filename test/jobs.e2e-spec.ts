import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { OmxExecService } from '../src/jobs/omx-exec.service';
import type { BridgeJob, OmxExecutionResult } from '../src/jobs/job.types';
import { createTempDir, createValidationPipe, waitFor } from './helpers';

class FakeOmxExecService {
  public readonly calls: string[] = [];
  public maxConcurrent = 0;
  private activeCount = 0;

  async execute(prompt: string): Promise<OmxExecutionResult> {
    this.calls.push(prompt);
    this.activeCount += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.activeCount);

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

  async function getJob(jobId: string): Promise<BridgeJob> {
    const response = await request(app.getHttpServer()).get(`/jobs/${jobId}`);
    expect(response.status).toBe(200);
    return response.body as BridgeJob;
  }

  beforeEach(async () => {
    jobsDirectory = await createTempDir('bridge-e2e');
    process.env.BRIDGE_JOBS_DIR = jobsDirectory;
    process.env.BRIDGE_JOB_POLL_INTERVAL_MS = '10';
    fakeOmxExecService = new FakeOmxExecService();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OmxExecService)
      .useValue(fakeOmxExecService)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.BRIDGE_JOBS_DIR;
    delete process.env.BRIDGE_JOB_POLL_INTERVAL_MS;
  });

  it('submits, persists, executes, and returns a successful job', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/jobs')
      .send({ prompt: 'hello bridge', requestId: 'req-1' });

    expect(createResponse.status).toBe(202);
    const { jobId } = createResponse.body as { jobId: string };
    await expect(fs.stat(path.join(jobsDirectory, `${jobId}.json`))).resolves.toBeDefined();

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
    const failResponse = await request(app.getHttpServer())
      .post('/jobs')
      .send({ prompt: 'please fail' });
    expect(failResponse.status).toBe(202);

    const failedJob = await waitFor(
      () => getJob(failResponse.body.jobId as string),
      (job) => job.status === 'failed',
    );

    expect(failedJob.stderr).toContain('failed:please fail');
    expect(failedJob.exitCode).toBe(1);

    const successResponse = await request(app.getHttpServer())
      .post('/jobs')
      .send({ prompt: 'still alive' });
    expect(successResponse.status).toBe(202);
  });

  it('processes jobs in FIFO order with only one running at a time', async () => {
    const submissions = [];
    for (const prompt of ['first', 'second', 'third']) {
      submissions.push(
        await request(app.getHttpServer()).post('/jobs').send({ prompt }),
      );
    }

    const jobIds = submissions.map((response) => response.body.jobId as string);
    await waitFor(
      async () => Promise.all(jobIds.map((jobId) => getJob(jobId))),
      (jobs) => jobs.every((job) => job.status === 'succeeded'),
      5_000,
    );

    expect(fakeOmxExecService.calls).toEqual(['first', 'second', 'third']);
    expect(fakeOmxExecService.maxConcurrent).toBe(1);
  });
});
