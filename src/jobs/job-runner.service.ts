import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import { JobQueueRepository } from './job-queue.repository';
import { OmxExecService } from './omx-exec.service';
import { JobNotifyService } from './job-notify.service';
import type { BridgeJob } from './job.types';

@Injectable()
export class JobRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobRunnerService.name);
  private intervalHandle?: NodeJS.Timeout;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly inFlight = new Set<string>();
  private claimMutex: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(
    private readonly repository: JobQueueRepository,
    private readonly omxExecService: OmxExecService,
    private readonly jobNotify: JobNotifyService,
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    this.shuttingDown = false;
    await this.repository.ensureReady();
    await this.recoverInterruptedJobs();
    this.intervalHandle = setInterval(() => this.tick(), this.config.jobPollIntervalMs);
    this.tick();
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
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
    const claimed = await this.claimNext();
    if (!claimed) {
      return false;
    }

    try {
      await this.executeJob(claimed);
      return true;
    } finally {
      this.inFlight.delete(claimed.id);
      this.tick();
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

  trigger(): void {
    this.tick();
  }

  private tick(): void {
    if (this.shuttingDown) {
      return;
    }
    const slots = this.config.maxConcurrency - this.inFlight.size;
    for (let i = 0; i < slots; i++) {
      void this.runOnce();
    }
  }

  // 클레임 단계는 직렬화: size 체크와 listByStatus + inFlight.add가 한 임계영역에서 일어나야
  // 동시 호출 시 같은 잡이 중복 클레임되지 않는다.
  private async claimNext(): Promise<BridgeJob | null> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.claimMutex;
    this.claimMutex = next;
    await prev;
    try {
      if (this.inFlight.size >= this.config.maxConcurrency) {
        return null;
      }
      const queuedJobs = await this.repository.listByStatus('queued');
      const candidate = queuedJobs.find((job) => !this.inFlight.has(job.id));
      if (!candidate) {
        return null;
      }
      this.inFlight.add(candidate.id);
      return candidate;
    } finally {
      release();
    }
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

      const savedJob = await this.repository.save({
        ...latestJob,
        status: result.status,
        finishedAt: new Date().toISOString(),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        execution: result.execution,
      });
      void this.jobNotify.notifyJobComplete(savedJob);
    } finally {
      this.abortControllers.delete(job.id);
    }
  }
}
