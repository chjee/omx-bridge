import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import { JobQueueRepository } from './job-queue.repository';
import { OmxExecService } from './omx-exec.service';
import type { BridgeJob } from './job.types';

@Injectable()
export class JobRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobRunnerService.name);
  private intervalHandle?: NodeJS.Timeout;
  private readonly abortControllers = new Map<string, AbortController>();
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

    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
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

  async cancel(jobId: string): Promise<boolean> {
    const controller = this.abortControllers.get(jobId);
    if (!controller) {
      return false;
    }

    controller.abort();
    return true;
  }

  private async getNextQueuedJob(): Promise<BridgeJob | null> {
    const queuedJobs = await this.repository.listByStatus('queued');
    return queuedJobs[0] ?? null;
  }

  private async executeJob(job: BridgeJob): Promise<void> {
    const currentJob = await this.repository.getById(job.id);
    if (!currentJob || currentJob.status !== 'queued') {
      return;
    }

    this.logger.log(`Running job ${job.id}`);
    const runningJob: BridgeJob = {
      ...currentJob,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      stdout: '',
      stderr: '',
    };

    await this.repository.save(runningJob);

    const abortController = new AbortController();
    this.abortControllers.set(job.id, abortController);

    try {
      const result = await this.omxExecService.execute(job.prompt, {
        signal: abortController.signal,
        cwd: job.cwd,
      });
      const latestJob = await this.repository.getById(job.id);
      if (!latestJob || latestJob.status !== 'running') {
        return;
      }

      await this.repository.save({
        ...latestJob,
        status: result.status,
        finishedAt: new Date().toISOString(),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        execution: result.execution,
      });
    } finally {
      this.abortControllers.delete(job.id);
    }
  }
}
