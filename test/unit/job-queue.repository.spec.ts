import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import type { BridgeJob } from '../../src/jobs/job.types';
import { createTempDir } from '../helpers';

// UUID v4 형식의 테스트용 고정 ID (UUID 검증 로직에 대응)
const TEST_ID_1 = '00000000-0000-4000-a000-000000000001';
const TEST_ID_2 = '00000000-0000-4000-a000-000000000002';
const TEST_ID_3 = '00000000-0000-4000-a000-000000000003';

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? TEST_ID_1,
    prompt: overrides.prompt ?? 'hello',
    queueOrder: overrides.queueOrder ?? '0000000000001-000001',
    status: overrides.status ?? 'queued',
    createdAt: overrides.createdAt ?? '2026-04-02T00:00:00.000Z',
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt,
    exitCode: overrides.exitCode ?? null,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    requestId: overrides.requestId,
    metadata: overrides.metadata,
    execution: overrides.execution ?? {
      command: 'omx',
      timeoutMs: 1000,
      maxOutputChars: 500,
    },
  };
}

describe('JobQueueRepository', () => {
  let jobsDirectory: string;
  let repository: JobQueueRepository;

  beforeEach(async () => {
    jobsDirectory = await createTempDir('bridge-jobs');
    const config: BridgeConfig = {
      jobsDirectory,
      omxCommand: 'omx',
      jobPollIntervalMs: 10,
      jobTimeoutMs: 1000,
      maxOutputChars: 500,
      sigkillGraceMs: 5000,
      maxConcurrency: 1,
      maxActiveJobs: 50,
      jobRetentionDays: 7,
      maxTerminalJobs: 1000,
      jobCleanupIntervalMs: 3600000,
      notifyTimeoutMs: 5000,
      notifyMode: 'openclaw',
    };

    repository = new JobQueueRepository(config);
  });

  it('creates the queue directory if missing', async () => {
    await fs.rm(jobsDirectory, { recursive: true, force: true });

    await repository.ensureReady();

    await expect(fs.stat(jobsDirectory)).resolves.toBeDefined();
  });

  it('writes and reads a queued job file', async () => {
    const job = createJob();

    await repository.save(job);

    const jobPath = path.join(jobsDirectory, `${job.id}.json`);
    await expect(fs.stat(jobPath)).resolves.toBeDefined();
    await expect(repository.getById(job.id)).resolves.toEqual(job);
  });

  it('updates status fields without dropping existing fields', async () => {
    const job = createJob({ metadata: { source: 'openclaw' } });
    await repository.save(job);

    const updated = {
      ...job,
      status: 'succeeded' as const,
      finishedAt: '2026-04-02T00:01:00.000Z',
      stdout: 'done',
      exitCode: 0,
    };

    await repository.save(updated);

    await expect(repository.getById(job.id)).resolves.toEqual(updated);
  });

  it('lists queued jobs in deterministic FIFO order', async () => {
    await repository.save(
      createJob({ id: TEST_ID_2, createdAt: '2026-04-02T00:00:02.000Z' }),
    );
    await repository.save(
      createJob({ id: TEST_ID_1, createdAt: '2026-04-02T00:00:01.000Z' }),
    );
    await repository.save(
      createJob({
        id: TEST_ID_3,
        createdAt: '2026-04-02T00:00:03.000Z',
        status: 'failed',
      }),
    );

    const queuedJobs = await repository.listByStatus('queued');

    expect(queuedJobs.map((job) => job.id)).toEqual([TEST_ID_1, TEST_ID_2]);
  });

  it('counts only queued and running jobs as active', async () => {
    await repository.save(createJob({ id: TEST_ID_1, status: 'queued' }));
    await repository.save(createJob({ id: TEST_ID_2, status: 'running' }));
    await repository.save(createJob({
      id: TEST_ID_3,
      status: 'succeeded',
      finishedAt: '2026-04-02T00:00:03.000Z',
    }));

    await expect(repository.countActive()).resolves.toBe(2);
  });

  it('cleans up old terminal jobs without deleting active jobs', async () => {
    await repository.save(createJob({
      id: TEST_ID_1,
      status: 'succeeded',
      finishedAt: '2026-04-01T00:00:00.000Z',
    }));
    await repository.save(createJob({
      id: TEST_ID_2,
      status: 'failed',
      finishedAt: '2026-04-26T00:00:00.000Z',
    }));
    await repository.save(createJob({ id: TEST_ID_3, status: 'queued' }));

    const result = await repository.cleanupTerminalJobs({
      retentionDays: 7,
      maxTerminalJobs: 1000,
      now: new Date('2026-04-27T00:00:00.000Z'),
    });

    expect(result).toEqual({ deleted: 1, retained: 1 });
    await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();
    await expect(repository.getById(TEST_ID_2)).resolves.toMatchObject({ status: 'failed' });
    await expect(repository.getById(TEST_ID_3)).resolves.toMatchObject({ status: 'queued' });
  });

  it('enforces max terminal job retention by deleting oldest terminal files', async () => {
    await repository.save(createJob({
      id: TEST_ID_1,
      status: 'succeeded',
      finishedAt: '2026-04-25T00:00:00.000Z',
    }));
    await repository.save(createJob({
      id: TEST_ID_2,
      status: 'failed',
      finishedAt: '2026-04-26T00:00:00.000Z',
    }));
    await repository.save(createJob({
      id: TEST_ID_3,
      status: 'cancelled',
      finishedAt: '2026-04-27T00:00:00.000Z',
    }));

    const result = await repository.cleanupTerminalJobs({
      retentionDays: 30,
      maxTerminalJobs: 2,
      now: new Date('2026-04-27T00:00:00.000Z'),
    });

    expect(result).toEqual({ deleted: 1, retained: 2 });
    await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();
    await expect(repository.getById(TEST_ID_2)).resolves.toMatchObject({ status: 'failed' });
    await expect(repository.getById(TEST_ID_3)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('handles malformed job files predictably', async () => {
    // 파일 이름에 UUID가 아닌 값은 getById에서 BadRequestException이 발생함
    // listAll()은 파일명에서 직접 jobId를 추출하므로 UUID 검증 없이 파싱 시도
    const brokenId = '11111111-1111-4111-b111-111111111111';
    await fs.writeFile(path.join(jobsDirectory, `${brokenId}.json`), '{not-json', 'utf8');

    await expect(repository.getById(brokenId)).resolves.toBeNull();
    await expect(repository.listAll()).resolves.toEqual([]);
  });
});
