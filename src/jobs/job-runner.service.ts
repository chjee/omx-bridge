import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import { JobQueueRepository } from './job-queue.repository';
import { OmxExecService } from './omx-exec.service';
import { JobNotifyService } from './job-notify.service';
import type { BridgeJob, NotifyChannelResult, NotifyOutcome } from './job.types';
import { BridgeInstanceLockService } from './bridge-instance-lock.service';

@Injectable()
export class JobRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobRunnerService.name);
  private intervalHandle?: NodeJS.Timeout;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly inFlight = new Set<string>();
  private readonly inFlightRuns = new Map<string, Promise<void>>();
  private claimMutex: Promise<void> = Promise.resolve();
  private cleanupIntervalHandle?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(
    private readonly repository: JobQueueRepository,
    private readonly omxExecService: OmxExecService,
    private readonly jobNotify: JobNotifyService,
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
    @Optional() private readonly instanceLock?: BridgeInstanceLockService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.shuttingDown = false;
    await this.instanceLock?.acquire();
    await this.repository.ensureReady();
    await this.recoverInterruptedJobs();
    await this.cleanupTerminalJobs();
    void this.reconcileTerminalNotifications().catch((error) => {
      this.logger.warn(`Failed to reconcile terminal job notifications: ${String(error)}`);
    });
    this.cleanupIntervalHandle = setInterval(
      () => void this.cleanupTerminalJobs(),
      this.config.jobCleanupIntervalMs,
    );
    this.intervalHandle = setInterval(() => this.tick(), this.config.jobPollIntervalMs);
    this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = undefined;
    }

    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    await this.waitForInFlightRuns();
    this.abortControllers.clear();
    await this.instanceLock?.release();
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

  async cleanupTerminalJobs(): Promise<void> {
    const result = await this.repository.cleanupTerminalJobs({
      retentionDays: this.config.jobRetentionDays,
      maxTerminalJobs: this.config.maxTerminalJobs,
    });
    if (result.deleted > 0) {
      this.logger.log(
        `Cleaned up ${result.deleted} terminal job file(s); retained ${result.retained}`,
      );
    }
  }

  async reconcileTerminalNotifications(): Promise<number> {
    const terminalJobs = (await this.repository.listAll())
      .filter((job) => this.isTerminal(job.status))
      .filter((job) => this.shouldReconcileNotification(job.notifyOutcome));

    let attempted = 0;
    for (const job of terminalJobs) {
      if (this.shuttingDown) {
        break;
      }
      try {
        await this.jobNotify.notifyJobComplete(job);
        attempted += 1;
      } catch (error) {
        this.logger.warn(`Failed to reconcile completion notification for ${job.id}: ${String(error)}`);
      }
    }

    if (attempted > 0) {
      this.logger.log(`Reconciled ${attempted} terminal job notification(s)`);
    }
    return attempted;
  }

  async runOnce(): Promise<boolean> {
    const claimed = await this.claimNext();
    if (!claimed) {
      return false;
    }

    try {
      const run = this.executeJob(claimed);
      this.inFlightRuns.set(claimed.id, run);
      await run;
      return true;
    } finally {
      this.inFlightRuns.delete(claimed.id);
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

  private isTerminal(status: BridgeJob['status']): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
  }

  private shouldReconcileNotification(outcome: NotifyOutcome | undefined): boolean {
    if (!outcome) {
      return true;
    }

    const channelResults = this.notifyChannelResults(outcome);
    if (channelResults.length === 0) {
      return true;
    }
    if (channelResults.some((result) => result.status === 'ok')) {
      return false;
    }
    if (channelResults.some((result) => result.status === 'failed')) {
      return true;
    }

    return false;
  }

  private notifyChannelResults(outcome: NotifyOutcome): NotifyChannelResult[] {
    return [outcome.claudeWebhook, outcome.openclaw, outcome.telegram]
      .filter((result): result is NotifyChannelResult => result !== undefined);
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
    } catch (error) {
      await this.markRunningJobFailed(job.id, error);
    } finally {
      this.abortControllers.delete(job.id);
    }
  }

  private async markRunningJobFailed(jobId: string, error: unknown): Promise<void> {
    const latestJob = await this.repository.getById(jobId);
    if (!latestJob || latestJob.status !== 'running') {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const savedJob = await this.repository.save({
      ...latestJob,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      exitCode: latestJob.exitCode ?? null,
      stderr: latestJob.stderr || `Unexpected OMX execution error: ${message}`,
      execution: {
        ...latestJob.execution,
        errorType: 'execution_error',
      },
    });
    this.logger.error(`Job ${jobId} failed after an unexpected execution error: ${message}`);
    void this.jobNotify.notifyJobComplete(savedJob);
  }

  private async waitForInFlightRuns(): Promise<void> {
    const runs = [...this.inFlightRuns.values()];
    if (runs.length === 0) {
      return;
    }

    const timeoutMs = this.config.sigkillGraceMs + 2_000;
    let timeoutHandle: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(runs),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timeoutHandle);
  }
}
