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
    executionMode: overrides.executionMode,
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
    session: overrides.session,
    execution: overrides.execution ?? {
      command: 'omx',
      timeoutMs: 1000,
      maxOutputChars: 500,
    },
  };
}

describe('JobQueueRepository', () => {
  let jobsDirectory: string;
  let config: BridgeConfig;
  let repository: JobQueueRepository;

  beforeEach(async () => {
    jobsDirectory = await createTempDir('bridge-jobs');
    config = {
      host: '127.0.0.1',
      jobsDirectory,
      omxCommand: 'omx',
      tmuxCommand: 'tmux',
      tmuxSessionsDirectory: path.join(jobsDirectory, 'sessions'),
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
      insecureLoopback: false,
      allowedCwdPrefixes: ['/workspace'],
    };

    repository = new JobQueueRepository(config);
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates the queue directory if missing', async () => {
    await fs.rm(jobsDirectory, { recursive: true, force: true });

    await repository.ensureReady();

    const directoryStat = await fs.stat(jobsDirectory);
    expect(directoryStat.isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(directoryStat.mode & 0o777).toBe(0o700);
    }
  });

  it('tightens the queue directory without rewriting existing job files', async () => {
    if (process.platform === 'win32') return;
    const existingPath = path.join(jobsDirectory, `${TEST_ID_1}.json`);
    const existingPayload = `${JSON.stringify(createJob(), null, 2)}\n`;
    await fs.chmod(jobsDirectory, 0o755);
    await fs.writeFile(existingPath, existingPayload, { encoding: 'utf8', mode: 0o644 });
    const before = await fs.stat(existingPath);

    await repository.ensureReady();

    const directoryStat = await fs.stat(jobsDirectory);
    const after = await fs.stat(existingPath);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(after.mode & 0o777).toBe(0o644);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await expect(fs.readFile(existingPath, 'utf8')).resolves.toBe(existingPayload);
  });

  it('does not chmod a configured directory with unrelated entries', async () => {
    if (process.platform === 'win32') return;
    const externalDirectory = await createTempDir('bridge-external');
    await fs.chmod(externalDirectory, 0o755);
    await fs.writeFile(path.join(externalDirectory, 'unrelated.txt'), 'keep', 'utf8');
    const externalRepository = new JobQueueRepository({
      ...config,
      jobsDirectory: externalDirectory,
      tmuxSessionsDirectory: path.join(externalDirectory, 'sessions'),
    });

    await expect(externalRepository.ensureReady()).resolves.toBeUndefined();

    const directoryStat = await fs.stat(externalDirectory);
    expect(directoryStat.mode & 0o777).toBe(0o755);
    await expect(fs.readFile(path.join(externalDirectory, 'unrelated.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('rejects a symlinked jobs ancestor without changing the target mode and can retry', async () => {
    if (process.platform === 'win32') return;
    const targetDirectory = await createTempDir('bridge-jobs-target');
    const linkParent = await createTempDir('bridge-jobs-link');
    const linkedAncestor = path.join(linkParent, 'linked');
    const linkedDirectory = path.join(linkedAncestor, 'jobs');
    await fs.chmod(targetDirectory, 0o755);
    await fs.symlink(targetDirectory, linkedAncestor, 'dir');
    const linkedRepository = new JobQueueRepository({
      ...config,
      jobsDirectory: linkedDirectory,
      tmuxSessionsDirectory: path.join(linkedDirectory, 'sessions'),
    });

    await expect(linkedRepository.ensureReady()).rejects.toThrow('symbolic link');

    const targetStat = await fs.stat(targetDirectory);
    expect(targetStat.mode & 0o777).toBe(0o755);
    await expect(fs.stat(path.join(targetDirectory, 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(linkedAncestor);
    await fs.mkdir(linkedDirectory, { recursive: true, mode: 0o700 });
    await expect(linkedRepository.ensureReady()).resolves.toBeUndefined();
  });

  it('writes and reads a queued job file', async () => {
    const job = createJob();
    const writeSpy = jest.spyOn(fs, 'writeFile');

    await repository.save(job);

    const jobPath = path.join(jobsDirectory, `${job.id}.json`);
    const jobStat = await fs.stat(jobPath);
    if (process.platform !== 'win32') {
      expect(jobStat.mode & 0o777).toBe(0o600);
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\.tmp$/),
        expect.any(String),
        { encoding: 'utf8', mode: 0o600 },
      );
    }
    await expect(repository.getById(job.id)).resolves.toEqual(job);
  });

  it('serializes conditional transitions per job so the first durable terminal write wins', async () => {
    const job = createJob({ status: 'running' });
    await repository.save(job);
    const originalRename = fs.rename.bind(fs);
    let entered!: () => void;
    let release!: () => void;
    const atRename = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let blocked = false;
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!blocked) {
        blocked = true;
        entered();
        await barrier;
      }
      return originalRename(from, to);
    });

    const winner = repository.transition(job.id, ['running'], (current) => ({ ...current, status: 'succeeded' }));
    await atRename;
    const loser = repository.transition(job.id, ['running'], (current) => ({ ...current, status: 'failed' }));
    release();

    await expect(winner).resolves.toMatchObject({ transitioned: true, job: { status: 'succeeded' } });
    await expect(loser).resolves.toMatchObject({ transitioned: false, job: { status: 'succeeded' } });
  });

  it('removes its owned temp file after rename failure and preserves the primary error', async () => {
    const job = createJob();
    const failure = Object.assign(new Error('rename failed'), { code: 'EIO' });
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(failure);

    await expect(repository.save(job)).rejects.toBe(failure);
    expect((await fs.readdir(jobsDirectory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await expect(repository.getById(job.id)).resolves.toBeNull();
  });

  it('removes its owned temp file after a partial write failure', async () => {
    const job = createJob();
    const originalWrite = fs.writeFile.bind(fs);
    const failure = Object.assign(new Error('write failed'), { code: 'ENOSPC' });
    jest.spyOn(fs, 'writeFile').mockImplementationOnce(async (file, data, options) => {
      await originalWrite(file, data, options);
      throw failure;
    });

    await expect(repository.save(job)).rejects.toBe(failure);
    expect((await fs.readdir(jobsDirectory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
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

  it('reads jobs with validated optional persisted fields', async () => {
    const job = createJob({
      status: 'succeeded',
      finishedAt: '2026-04-02T00:01:00.000Z',
      exitCode: 0,
      execution: {
        command: 'omx',
        timeoutMs: 1000,
        maxOutputChars: 500,
        durationMs: 250,
        timedOut: false,
        outputTruncated: true,
        errorType: 'non_zero_exit',
        recoveredFromRestart: false,
      },
    });
    const persisted: BridgeJob = {
      ...job,
      cwd: '/workspace/app',
      requestId: 'req-1',
      requestFingerprint: 'fingerprint',
      originRoutingKey: 'telegram:direct:123',
      source: 'dispatch',
      sourceName: 'omx-dispatch',
      metadata: { source: 'dispatch' },
      notifyUrl: 'http://127.0.0.1:3993/notify',
      notifyOutcome: {
        attemptedAt: '2026-04-02T00:01:01.000Z',
        mode: 'claude',
        trigger: 'manual',
        attemptIndex: 0,
        claudeWebhook: { status: 'failed', error: 'http_500', httpStatus: 500, attempts: 1 },
        telegram: { status: 'skipped', skippedReason: 'per_job_webhook_failed' },
      },
      notifyHistory: [
        {
          attemptedAt: '2026-04-02T00:01:01.000Z',
          mode: 'claude',
          trigger: 'manual',
          attemptIndex: 0,
          claudeWebhook: { status: 'failed', error: 'http_500', httpStatus: 500, attempts: 1 },
          telegram: { status: 'skipped', skippedReason: 'per_job_webhook_failed' },
        },
      ],
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-0001',
        status: 'running',
        createdAt: '2026-04-02T00:00:30.000Z',
        updatedAt: '2026-04-02T00:00:31.000Z',
        attachCommand: 'tmux attach-session -t omx-bridge-0001',
        cwd: '/workspace/app',
        lastExitCode: null,
      },
    };

    await repository.save(persisted);

    await expect(repository.getById(job.id)).resolves.toEqual(persisted);
  });

  it('normalizes legacy persisted synapse source to channel', async () => {
    const legacyJob = {
      ...createJob({ id: TEST_ID_1 }),
      source: 'synapse',
      originRoutingKey: 'telegram:direct:123',
    };
    await fs.writeFile(
      path.join(jobsDirectory, `${TEST_ID_1}.json`),
      `${JSON.stringify(legacyJob)}\n`,
      'utf8',
    );

    await expect(repository.getById(TEST_ID_1)).resolves.toMatchObject({
      source: 'channel',
      sourceName: 'claude-synapse',
      originRoutingKey: 'telegram:direct:123',
    });
  });

  it('reads jobs with tmux execution contract fields', async () => {
    const job = createJob({
      executionMode: 'tmux',
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-job-1',
        status: 'starting',
        createdAt: '2026-04-02T00:00:30.000Z',
        updatedAt: '2026-04-02T00:00:30.000Z',
        attachCommand: 'tmux attach-session -t omx-bridge-job-1',
        cwd: '/workspace/app',
      },
    });

    await repository.save(job);

    await expect(repository.getById(job.id)).resolves.toEqual(job);
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

    expect(result).toEqual({
      deleted: 1,
      retained: 1,
      deletedEntries: [{ jobId: TEST_ID_1, executionMode: 'exec' }],
    });
    await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();
    await expect(repository.getById(TEST_ID_2)).resolves.toMatchObject({ status: 'failed' });
    await expect(repository.getById(TEST_ID_3)).resolves.toMatchObject({ status: 'queued' });
  });

  it('uses createdAt as the cleanup age for terminal jobs missing finishedAt', async () => {
    await repository.save(createJob({
      id: TEST_ID_1,
      status: 'succeeded',
      createdAt: '2026-04-01T00:00:00.000Z',
      finishedAt: undefined,
    }));
    await repository.save(createJob({
      id: TEST_ID_2,
      status: 'failed',
      createdAt: '2026-04-26T00:00:00.000Z',
      finishedAt: undefined,
    }));

    const result = await repository.cleanupTerminalJobs({
      retentionDays: 7,
      maxTerminalJobs: 1000,
      now: new Date('2026-04-27T00:00:00.000Z'),
    });

    expect(result).toEqual({
      deleted: 1,
      retained: 1,
      deletedEntries: [{ jobId: TEST_ID_1, executionMode: 'exec' }],
    });
    await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();
    await expect(repository.getById(TEST_ID_2)).resolves.toMatchObject({ status: 'failed' });
  });

  it('uses createdAt as the cleanup age for terminal jobs with blank finishedAt', async () => {
    await repository.save(createJob({
      id: TEST_ID_1,
      status: 'succeeded',
      createdAt: '2026-04-01T00:00:00.000Z',
      finishedAt: '',
    }));
    await repository.save(createJob({
      id: TEST_ID_2,
      status: 'failed',
      createdAt: '2026-04-26T00:00:00.000Z',
      finishedAt: '',
    }));

    const result = await repository.cleanupTerminalJobs({
      retentionDays: 7,
      maxTerminalJobs: 1000,
      now: new Date('2026-04-27T00:00:00.000Z'),
    });

    expect(result).toEqual({
      deleted: 1,
      retained: 1,
      deletedEntries: [{ jobId: TEST_ID_1, executionMode: 'exec' }],
    });
    await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();
    await expect(repository.getById(TEST_ID_2)).resolves.toMatchObject({ status: 'failed' });
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

    expect(result).toEqual({
      deleted: 1,
      retained: 2,
      deletedEntries: [{ jobId: TEST_ID_1, executionMode: 'exec' }],
    });
    await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();
    await expect(repository.getById(TEST_ID_2)).resolves.toMatchObject({ status: 'failed' });
    await expect(repository.getById(TEST_ID_3)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('returns persisted tmux cleanup evidence for deleted terminal jobs', async () => {
    await repository.save(createJob({
      status: 'succeeded',
      executionMode: 'tmux',
      finishedAt: '2026-04-01T00:00:00.000Z',
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-cleanup',
        status: 'exited',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:01:00.000Z',
        attachCommand: 'tmux attach -t omx-bridge-cleanup',
      },
    }));

    const result = await repository.cleanupTerminalJobs({
      retentionDays: 7,
      maxTerminalJobs: 1000,
      now: new Date('2026-04-27T00:00:00.000Z'),
    });

    expect(result.deletedEntries).toEqual([{
      jobId: TEST_ID_1,
      executionMode: 'tmux',
      sessionName: 'omx-bridge-cleanup',
    }]);
  });

  it('handles malformed job files predictably', async () => {
    const brokenId = '11111111-1111-4111-b111-111111111111';
    const brokenPath = path.join(jobsDirectory, `${brokenId}.json`);
    await fs.writeFile(brokenPath, '{not-json', 'utf8');

    await expect(repository.getById(brokenId)).resolves.toBeNull();
    await expect(fs.stat(brokenPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const invalidEntries = await fs.readdir(path.join(jobsDirectory, 'invalid'));
    expect(invalidEntries).toHaveLength(1);
    expect(invalidEntries[0]).toMatch(new RegExp(`^${brokenId}\\.malformed\\..+\\.json$`));
    if (process.platform !== 'win32') {
      const quarantineDirectoryStat = await fs.stat(path.join(jobsDirectory, 'invalid'));
      const quarantineFileStat = await fs.stat(path.join(jobsDirectory, 'invalid', invalidEntries[0]!));
      expect(quarantineDirectoryStat.mode & 0o777).toBe(0o700);
      expect(quarantineFileStat.mode & 0o777).toBe(0o600);
    }
    await expect(repository.listAll()).resolves.toEqual([]);
  });

  it('does not quarantine through an exact invalid-directory symlink', async () => {
    if (process.platform === 'win32') return;
    const brokenId = '11111111-1111-4111-b111-111111111111';
    const brokenPath = path.join(jobsDirectory, `${brokenId}.json`);
    const externalTarget = await createTempDir('bridge-invalid-target');
    await fs.chmod(externalTarget, 0o755);
    await fs.symlink(externalTarget, path.join(jobsDirectory, 'invalid'), 'dir');
    await fs.writeFile(brokenPath, '{not-json', { encoding: 'utf8', mode: 0o644 });

    await expect(repository.getById(brokenId)).resolves.toBeNull();

    await expect(fs.readFile(brokenPath, 'utf8')).resolves.toBe('{not-json');
    expect(await fs.readdir(externalTarget)).toEqual([]);
    const targetStat = await fs.stat(externalTarget);
    expect(targetStat.mode & 0o777).toBe(0o755);
  });

  it('does not quarantine through a symlinked jobs ancestor', async () => {
    if (process.platform === 'win32') return;
    const brokenId = '11111111-1111-4111-b111-111111111111';
    const externalTarget = await createTempDir('bridge-invalid-ancestor-target');
    const linkParent = await createTempDir('bridge-invalid-ancestor-link');
    const linkedAncestor = path.join(linkParent, 'linked');
    const realJobsDirectory = path.join(externalTarget, 'jobs');
    const linkedJobsDirectory = path.join(linkedAncestor, 'jobs');
    await fs.mkdir(realJobsDirectory, { mode: 0o755 });
    await fs.symlink(externalTarget, linkedAncestor, 'dir');
    const brokenPath = path.join(realJobsDirectory, `${brokenId}.json`);
    await fs.writeFile(brokenPath, '{not-json', { encoding: 'utf8', mode: 0o644 });
    const linkedRepository = new JobQueueRepository({
      ...config,
      jobsDirectory: linkedJobsDirectory,
      tmuxSessionsDirectory: path.join(linkedJobsDirectory, 'sessions'),
    });

    await expect(linkedRepository.getById(brokenId)).resolves.toBeNull();

    await expect(fs.readFile(brokenPath, 'utf8')).resolves.toBe('{not-json');
    await expect(fs.stat(path.join(realJobsDirectory, 'invalid'))).rejects.toMatchObject({ code: 'ENOENT' });
    const jobsStat = await fs.stat(realJobsDirectory);
    expect(jobsStat.mode & 0o777).toBe(0o755);
  });

  it('does not use an invalid directory that contains unrelated entries', async () => {
    if (process.platform === 'win32') return;
    const brokenId = '11111111-1111-4111-b111-111111111111';
    const brokenPath = path.join(jobsDirectory, `${brokenId}.json`);
    const quarantineDirectory = path.join(jobsDirectory, 'invalid');
    await fs.mkdir(quarantineDirectory, { mode: 0o755 });
    await fs.writeFile(path.join(quarantineDirectory, 'unrelated.txt'), 'keep', 'utf8');
    await fs.writeFile(brokenPath, '{not-json', { encoding: 'utf8', mode: 0o644 });

    await expect(repository.getById(brokenId)).resolves.toBeNull();

    await expect(fs.readFile(brokenPath, 'utf8')).resolves.toBe('{not-json');
    await expect(fs.readFile(path.join(quarantineDirectory, 'unrelated.txt'), 'utf8')).resolves.toBe('keep');
    const quarantineStat = await fs.stat(quarantineDirectory);
    expect(quarantineStat.mode & 0o777).toBe(0o755);
  });

  it('does not quarantine a job path that is itself a symlink', async () => {
    if (process.platform === 'win32') return;
    const brokenId = '11111111-1111-4111-b111-111111111111';
    const externalFile = path.join(await createTempDir('bridge-invalid-file-target'), 'external.json');
    const brokenPath = path.join(jobsDirectory, `${brokenId}.json`);
    await fs.writeFile(externalFile, '{not-json', { encoding: 'utf8', mode: 0o644 });
    await fs.symlink(externalFile, brokenPath, 'file');

    await expect(repository.getById(brokenId)).resolves.toBeNull();

    const brokenStat = await fs.lstat(brokenPath);
    const externalStat = await fs.stat(externalFile);
    expect(brokenStat.isSymbolicLink()).toBe(true);
    expect(externalStat.mode & 0o777).toBe(0o644);
    await expect(fs.readFile(externalFile, 'utf8')).resolves.toBe('{not-json');
    await expect(fs.stat(path.join(jobsDirectory, 'invalid'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('continues quarantining after a non-UUID malformed JSON filename', async () => {
    const foreignPath = path.join(jobsDirectory, 'foreign.json');
    const uuidPath = path.join(jobsDirectory, `${TEST_ID_1}.json`);
    await fs.writeFile(foreignPath, '{not-json', 'utf8');

    await expect(repository.listAll()).resolves.toEqual([]);

    await fs.writeFile(uuidPath, '{not-json', 'utf8');
    await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();

    const quarantined = await fs.readdir(path.join(jobsDirectory, 'invalid'));
    expect(quarantined).toHaveLength(2);
    expect(quarantined).toEqual(expect.arrayContaining([
      expect.stringMatching(/^foreign\.malformed\..+\.json$/),
      expect.stringMatching(new RegExp(`^${TEST_ID_1}\\.malformed\\..+\\.json$`)),
    ]));
  });

  it('skips structurally invalid job files without breaking cleanup', async () => {
    const invalidPath = path.join(jobsDirectory, `${TEST_ID_1}.json`);
    await fs.writeFile(
      invalidPath,
      `${JSON.stringify({
        ...createJob({
          id: 'not-a-job-id',
          status: 'succeeded',
          finishedAt: '2026-04-01T00:00:00.000Z',
        }),
      })}\n`,
      'utf8',
    );

    await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();
    await expect(fs.stat(invalidPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const invalidEntries = await fs.readdir(path.join(jobsDirectory, 'invalid'));
    expect(invalidEntries).toHaveLength(1);
    expect(invalidEntries[0]).toMatch(new RegExp(`^${TEST_ID_1}\\.invalid\\..+\\.json$`));
    await expect(repository.listAll()).resolves.toEqual([]);
    await expect(
      repository.cleanupTerminalJobs({
        retentionDays: 1,
        maxTerminalJobs: 1,
        now: new Date('2026-04-27T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ deleted: 0, retained: 0, deletedEntries: [] });
  });

  it('continues skipping invalid job files when quarantine fails', async () => {
    const invalidPath = path.join(jobsDirectory, `${TEST_ID_1}.json`);
    await fs.writeFile(
      invalidPath,
      `${JSON.stringify({ ...createJob({ id: 'not-a-job-id' }) })}\n`,
      'utf8',
    );
    const renameSpy = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('quarantine failed'));

    try {
      await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();
      const originalStat = await fs.stat(invalidPath);
      if (process.platform !== 'win32') {
        expect(originalStat.mode & 0o777).toBe(0o600);
      }
      await expect(repository.listAll()).resolves.toEqual([]);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it.each([
    ['invalid exitCode', { exitCode: '0' }],
    ['invalid source', { source: 'unknown' }],
    ['invalid metadata', { metadata: ['not', 'a', 'record'] }],
    ['invalid execution errorType', { execution: { errorType: 'unknown_error' } }],
    ['invalid execution durationMs', { execution: { durationMs: '250' } }],
    ['invalid notifyOutcome mode', { notifyOutcome: { mode: 'slack' } }],
    ['invalid notifyHistory entry', { notifyHistory: [{ mode: 'claude' }] }],
    ['invalid executionMode', { executionMode: 'screen' }],
    ['invalid tmux session backend', {
      session: {
        backend: 'screen',
        sessionName: 'omx-bridge-job-1',
        status: 'running',
        createdAt: '2026-04-02T00:00:30.000Z',
        updatedAt: '2026-04-02T00:00:31.000Z',
        attachCommand: 'tmux attach-session -t omx-bridge-job-1',
      },
    }],
    ['invalid tmux session status', {
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-job-1',
        status: 'paused',
        createdAt: '2026-04-02T00:00:30.000Z',
        updatedAt: '2026-04-02T00:00:31.000Z',
        attachCommand: 'tmux attach-session -t omx-bridge-job-1',
      },
    }],
    ['invalid notify channel status', {
      notifyOutcome: {
        attemptedAt: '2026-04-02T00:01:01.000Z',
        mode: 'claude',
        telegram: { status: 'sent' },
      },
    }],
  ])('skips job files with %s', async (_label, patch) => {
    const job: Record<string, unknown> = {
      ...createJob({
        id: TEST_ID_1,
        status: 'succeeded',
        finishedAt: '2026-04-02T00:01:00.000Z',
        exitCode: 0,
        execution: {
          command: 'omx',
          timeoutMs: 1000,
          maxOutputChars: 500,
          durationMs: 250,
          errorType: 'non_zero_exit',
        },
      }),
      notifyOutcome: {
        attemptedAt: '2026-04-02T00:01:01.000Z',
        mode: 'claude',
        telegram: { status: 'ok' },
      },
    };
    const patchRecord = patch as Record<string, unknown>;
    const patchExecution = patchRecord.execution;
    const invalidJob = {
      ...job,
      ...patch,
      execution: {
        ...(job.execution as Record<string, unknown>),
        ...(
          typeof patchExecution === 'object' && patchExecution !== null && !Array.isArray(patchExecution)
            ? patchExecution as Record<string, unknown>
            : {}
        ),
      },
    };

    await fs.writeFile(
      path.join(jobsDirectory, `${TEST_ID_1}.json`),
      `${JSON.stringify(invalidJob)}\n`,
      'utf8',
    );

    await expect(repository.getById(TEST_ID_1)).resolves.toBeNull();
  });
});
