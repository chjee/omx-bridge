import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import type { CreateJobDto } from './dto/create-job.dto';
import type { JobCallbackDto } from './dto/job-callback.dto';
import { JobQueueRepository } from './job-queue.repository';
import { JobRunnerService } from './job-runner.service';
import { JobNotifyService } from './job-notify.service';
import type { BridgeJob, JobExecutionMetadata, JobStatus } from './job.types';

export interface JobStats {
  queuedCount: number;
  runningCount: number;
  activeCount: number;
  terminalCount: number;
  maxActiveJobs: number;
  maxConcurrency: number;
  oldestQueuedAgeMs: number | null;
}

@Injectable()
export class JobsService {
  private queueSequence = 0;
  private createMutex: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: JobQueueRepository,
    private readonly jobRunnerService: JobRunnerService,
    private readonly jobNotify: JobNotifyService,
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
  ) {}

  async createJob(input: CreateJobDto): Promise<BridgeJob> {
    return this.withCreateLock(async () => {
      this.assertAllowedCwd(input.cwd);
      const activeCount = await this.repository.countActive();
      if (activeCount >= this.config.maxActiveJobs) {
        throw new HttpException(
          `Job queue is full (${activeCount}/${this.config.maxActiveJobs} active jobs)`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const job: BridgeJob = {
        id: randomUUID(),
        prompt: input.prompt,
        cwd: input.cwd,
        queueOrder: this.nextQueueOrder(),
        requestId: input.requestId,
        originRoutingKey: input.originRoutingKey,
        source: input.source,
        metadata: input.metadata,
        notifyUrl: input.notifyUrl,
        status: 'queued',
        createdAt: new Date().toISOString(),
        exitCode: null,
        stdout: '',
        stderr: '',
        execution: {
          command: this.config.omxCommand,
          timeoutMs: this.config.jobTimeoutMs,
          maxOutputChars: this.config.maxOutputChars,
        },
      };

      const savedJob = await this.repository.save(job);
      this.jobRunnerService.trigger();
      return savedJob;
    });
  }

  async listJobs(status?: JobStatus): Promise<BridgeJob[]> {
    if (status) {
      return this.repository.listByStatus(status);
    }

    return this.repository.listAll();
  }

  async getStats(): Promise<JobStats> {
    const jobs = await this.repository.listAll();
    const queuedJobs = jobs.filter((job) => job.status === 'queued');
    const runningCount = jobs.filter((job) => job.status === 'running').length;
    const terminalCount = jobs.filter((job) => this.isTerminal(job.status)).length;
    const oldestQueued = queuedJobs.reduce<BridgeJob | null>((oldest, job) => {
      if (!oldest) return job;
      return Date.parse(job.createdAt) < Date.parse(oldest.createdAt) ? job : oldest;
    }, null);

    return {
      queuedCount: queuedJobs.length,
      runningCount,
      activeCount: queuedJobs.length + runningCount,
      terminalCount,
      maxActiveJobs: this.config.maxActiveJobs,
      maxConcurrency: this.config.maxConcurrency,
      oldestQueuedAgeMs: oldestQueued ? Date.now() - Date.parse(oldestQueued.createdAt) : null,
    };
  }

  async getJobOrThrow(id: string): Promise<BridgeJob> {
    const job = await this.repository.getById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    return job;
  }

  async completeJobFromCallback(id: string, input: JobCallbackDto): Promise<BridgeJob> {
    const job = await this.getJobOrThrow(id);
    if (this.isTerminal(job.status)) {
      // 잡이 이미 terminal이면 callback을 idempotent하게 처리.
      // cancel 직후 callback이 늦게 도착하는 정상 race 등에서 caller에게 409를 던지지 않도록.
      return job;
    }

    const savedJob = await this.repository.save({
      ...job,
      status: input.status,
      finishedAt: new Date().toISOString(),
      exitCode: input.exitCode ?? job.exitCode ?? null,
      stdout: input.stdout ?? job.stdout,
      stderr: input.stderr ?? job.stderr,
      execution: {
        ...job.execution,
        ...this.projectCallbackExecution(input.execution),
      },
    });
    await this.jobRunnerService.cancel(id);
    void this.jobNotify.notifyJobComplete(savedJob);
    return savedJob;
  }

  async triggerNotifyRetry(id: string): Promise<BridgeJob> {
    const job = await this.getJobOrThrow(id);
    if (!this.isTerminal(job.status)) {
      throw new ConflictException(`Job ${id} is not terminal`);
    }

    await this.jobNotify.notifyJobComplete(job, { trigger: 'manual' });
    return this.getJobOrThrow(id);
  }

  async cancelJob(id: string): Promise<BridgeJob> {
    const job = await this.getJobOrThrow(id);
    if (job.status === 'cancelled') {
      return job;
    }

    if (this.isTerminal(job.status)) {
      throw new ConflictException(`Job ${id} is already ${job.status}`);
    }

    const savedJob = await this.repository.save({
      ...job,
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      exitCode: job.exitCode ?? null,
      stderr: job.stderr || 'Cancelled by API request',
      execution: {
        ...job.execution,
        errorType: 'cancelled',
      },
    });
    await this.jobRunnerService.cancel(id);
    return savedJob;
  }

  private projectCallbackExecution(
    execution: JobCallbackDto['execution'],
  ): Partial<Pick<JobExecutionMetadata, 'durationMs' | 'timedOut' | 'outputTruncated' | 'errorType'>> {
    if (!execution) return {};
    const patch: Partial<Pick<JobExecutionMetadata, 'durationMs' | 'timedOut' | 'outputTruncated' | 'errorType'>> = {};
    if (execution.durationMs !== undefined) patch.durationMs = execution.durationMs;
    if (execution.timedOut !== undefined) patch.timedOut = execution.timedOut;
    if (execution.outputTruncated !== undefined) patch.outputTruncated = execution.outputTruncated;
    if (execution.errorType !== undefined) patch.errorType = execution.errorType;
    return patch;
  }

  private isTerminal(status: JobStatus): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
  }

  private nextQueueOrder(): string {
    // {ms}-{seq}: ms는 unix epoch millis(현재 13자리), seq는 동일 ms 내 tie-breaker.
    // 프로세스 재시작 시 seq가 0으로 리셋되지만 listAll의 createdAt/id 보조 정렬이
    // 동일 (ms,seq) 충돌을 안정적으로 풀어준다.
    this.queueSequence += 1;
    return `${Date.now()}-${this.queueSequence.toString().padStart(6, '0')}`;
  }

  private assertAllowedCwd(cwd: string | undefined): void {
    if (!cwd) {
      return;
    }

    const resolvedCwd = path.resolve(cwd);
    const allowed = this.config.allowedCwdPrefixes.some((prefix) => {
      const resolvedPrefix = path.resolve(prefix);
      const relative = path.relative(resolvedPrefix, resolvedCwd);
      return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    });

    if (!allowed) {
      throw new HttpException(
        `cwd is outside allowed prefixes: ${cwd}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async withCreateLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.createMutex;
    this.createMutex = next;
    await prev;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
