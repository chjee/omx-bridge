import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import { JobQueueRepository } from './job-queue.repository';
import { OmxExecService } from './omx-exec.service';
import type { BridgeJob } from './job.types';

@Injectable()
export class JobRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobRunnerService.name);
  private intervalHandle?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repository: JobQueueRepository,
    private readonly omxExecService: OmxExecService,
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.repository.ensureReady();
    await this.recoverInterruptedJobs();
    this.intervalHandle = setInterval(() => {
      void this.runOnce();
    }, this.config.jobPollIntervalMs);
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  async recoverInterruptedJobs(): Promise<void> {
    const runningJobs = await this.repository.listByStatus('running');
    for (const job of runningJobs) {
      await this.repository.save({
        ...job,
        status: 'queued',
        startedAt: undefined,
        finishedAt: undefined,
        exitCode: null,
        stdout: '',
        stderr: job.stderr
          ? `${job.stderr}\nRecovered after process restart`
          : 'Recovered after process restart',
        execution: {
          ...job.execution,
          recoveredFromRestart: true,
        },
      });
    }
  }

  async runOnce(): Promise<boolean> {
    if (this.running) {
      return false;
    }

    this.running = true;
    try {
      const nextJob = await this.getNextQueuedJob();
      if (!nextJob) {
        return false;
      }

      await this.executeJob(nextJob);
      return true;
    } finally {
      this.running = false;
    }
  }

  private async getNextQueuedJob(): Promise<BridgeJob | null> {
    const queuedJobs = await this.repository.listByStatus('queued');
    return queuedJobs[0] ?? null;
  }

  private async executeJob(job: BridgeJob): Promise<void> {
    this.logger.log(`Running job ${job.id}`);
    const runningJob: BridgeJob = {
      ...job,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      stdout: '',
      stderr: '',
    };

    await this.repository.save(runningJob);

    const result = await this.omxExecService.execute(job.prompt);
    await this.repository.save({
      ...runningJob,
      status: result.status,
      finishedAt: new Date().toISOString(),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      execution: result.execution,
    });
  }
}
