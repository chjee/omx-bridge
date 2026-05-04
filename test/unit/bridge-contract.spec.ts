import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import { JobNotifyService } from '../../src/jobs/job-notify.service';
import { JobRunnerService } from '../../src/jobs/job-runner.service';
import { JobsService } from '../../src/jobs/jobs.service';
import {
  EXECUTION_ERROR_TYPES,
  JOB_EXECUTION_MODES,
  JOB_SOURCE_VALUES,
  JOB_STATUSES,
  TMUX_SESSION_STATUSES,
  type BridgeJob,
  type JobSessionSummary,
} from '../../src/jobs/job.types';
import { createTempDir } from '../helpers';

interface BridgeJobContract {
  jobStatuses: string[];
  jobExecutionModes: string[];
  executionErrorTypes: string[];
  tmuxSessionStatuses: string[];
  jobSources: string[];
  bridgeJob: BridgeJob;
  bridgeJobSession: JobSessionSummary;
}

async function loadContract(): Promise<BridgeJobContract> {
  const raw = await fs.readFile(path.join(process.cwd(), 'contracts', 'bridge-job.contract.json'), 'utf8');
  return JSON.parse(raw) as BridgeJobContract;
}

async function createConfig(): Promise<BridgeConfig> {
  const root = await createTempDir('bridge-contract');
  return {
    host: '127.0.0.1',
    jobsDirectory: path.join(root, 'jobs'),
    omxCommand: 'omx',
    tmuxCommand: 'tmux',
    tmuxSessionsDirectory: path.join(root, 'sessions'),
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
    allowedCwdPrefixes: [root],
  };
}

describe('bridge job contract', () => {
  it('keeps server contract constants aligned with the shared fixture', async () => {
    const contract = await loadContract();

    expect([...JOB_STATUSES]).toEqual(contract.jobStatuses);
    expect([...JOB_EXECUTION_MODES]).toEqual(contract.jobExecutionModes);
    expect([...EXECUTION_ERROR_TYPES]).toEqual(contract.executionErrorTypes);
    expect([...TMUX_SESSION_STATUSES]).toEqual(contract.tmuxSessionStatuses);
    expect([...JOB_SOURCE_VALUES]).toEqual(contract.jobSources);
  });

  it('accepts the shared full bridge job fixture through repository validation', async () => {
    const contract = await loadContract();
    const config = await createConfig();
    const repository = new JobQueueRepository(config);
    await repository.ensureReady();
    await fs.writeFile(
      path.join(config.jobsDirectory, `${contract.bridgeJob.id}.json`),
      `${JSON.stringify(contract.bridgeJob, null, 2)}\n`,
      'utf8',
    );

    await expect(repository.getById(contract.bridgeJob.id)).resolves.toEqual(contract.bridgeJob);
  });

  it('derives the shared session summary fixture from the full bridge job fixture', async () => {
    const contract = await loadContract();
    const jobs = new Map([[contract.bridgeJob.id, contract.bridgeJob]]);
    const repository = {
      getById: jest.fn(async (id: string) => jobs.get(id) ?? null),
    } as unknown as JobQueueRepository;
    const service = new JobsService(
      repository,
      { trigger: jest.fn() } as unknown as JobRunnerService,
      { notifyJobComplete: jest.fn() } as unknown as JobNotifyService,
      await createConfig(),
    );

    await expect(service.getJobSessionOrThrow(contract.bridgeJob.id)).resolves.toEqual(contract.bridgeJobSession);
  });
});
