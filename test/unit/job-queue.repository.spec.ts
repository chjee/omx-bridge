import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import type { BridgeJob } from '../../src/jobs/job.types';
import { createTempDir } from '../helpers';

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? 'job-1',
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

    await repository.create(job);

    const jobPath = path.join(jobsDirectory, `${job.id}.json`);
    await expect(fs.stat(jobPath)).resolves.toBeDefined();
    await expect(repository.getById(job.id)).resolves.toEqual(job);
  });

  it('updates status fields without dropping existing fields', async () => {
    const job = createJob({ metadata: { source: 'openclaw' } });
    await repository.create(job);

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
    await repository.create(
      createJob({ id: 'job-2', createdAt: '2026-04-02T00:00:02.000Z' }),
    );
    await repository.create(
      createJob({ id: 'job-1', createdAt: '2026-04-02T00:00:01.000Z' }),
    );
    await repository.create(
      createJob({
        id: 'job-3',
        createdAt: '2026-04-02T00:00:03.000Z',
        status: 'failed',
      }),
    );

    const queuedJobs = await repository.listByStatus('queued');

    expect(queuedJobs.map((job) => job.id)).toEqual(['job-1', 'job-2']);
  });

  it('handles malformed job files predictably', async () => {
    await fs.writeFile(path.join(jobsDirectory, 'broken.json'), '{not-json', 'utf8');

    await expect(repository.getById('broken')).resolves.toBeNull();
    await expect(repository.listAll()).resolves.toEqual([]);
  });
});
