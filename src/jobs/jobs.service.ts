import { ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import { CwdBoundaryError, resolveAllowedExecutionCwd } from './cwd-boundary';
import type { CreateJobDto } from './dto/create-job.dto';
import type { JobCallbackDto } from './dto/job-callback.dto';
import { JobQueueRepository } from './job-queue.repository';
import { JobRunnerService } from './job-runner.service';
import { JobNotifyService } from './job-notify.service';
import type { BridgeJob, JobExecutionMetadata, JobSessionSummary, JobStatus } from './job.types';

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
      const sourceNormalizedInput = this.normalizeLegacySource(input);
      const normalizedInput = {
        ...sourceNormalizedInput,
        cwd: await this.assertAllowedCwd(sourceNormalizedInput.cwd),
      };
      const requestFingerprint = this.buildRequestFingerprint(normalizedInput);
      const existingJob = await this.findExistingRequestJob(normalizedInput);
      if (existingJob) {
        this.assertRequestFingerprintMatches(existingJob, normalizedInput);
        return existingJob;
      }

      const activeCount = await this.repository.countActive();
      if (activeCount >= this.config.maxActiveJobs) {
        throw new HttpException(
          `Job queue is full (${activeCount}/${this.config.maxActiveJobs} active jobs)`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const job: BridgeJob = {
        id: randomUUID(),
        prompt: normalizedInput.prompt,
        executionMode: normalizedInput.executionMode ?? 'exec',
        cwd: normalizedInput.cwd,
        queueOrder: this.nextQueueOrder(),
        requestId: normalizedInput.requestId,
        requestFingerprint,
        originRoutingKey: normalizedInput.originRoutingKey,
        source: normalizedInput.source,
        sourceName: normalizedInput.sourceName,
        metadata: normalizedInput.metadata,
        notifyUrl: normalizedInput.notifyUrl,
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

  async getJobSessionOrThrow(id: string): Promise<JobSessionSummary> {
    const job = await this.getJobOrThrow(id);
    return {
      jobId: job.id,
      jobStatus: job.status,
      executionMode: job.executionMode ?? 'exec',
      attachCommand: job.session?.attachCommand ?? null,
      session: job.session ?? null,
    };
  }

  async completeJobFromCallback(id: string, input: JobCallbackDto): Promise<BridgeJob> {
    const transition = await this.repository.transition(id, ['queued', 'running'], (job) => ({
      ...job,
      status: input.status,
      finishedAt: new Date().toISOString(),
      exitCode: Object.prototype.hasOwnProperty.call(input, 'exitCode')
        ? input.exitCode ?? null
        : job.exitCode ?? null,
      stdout: input.stdout ?? job.stdout,
      stderr: input.stderr ?? job.stderr,
      execution: { ...job.execution, ...this.projectCallbackExecution(input.execution) },
    }));
    if (!transition.job) throw new NotFoundException(`Job ${id} not found`);
    if (!transition.transitioned) {
      if (this.isTerminal(transition.job.status) && this.isEquivalentCallbackReplay(transition.job, input)) {
        return transition.job;
      }
      throw new ConflictException(`Callback conflicts with stored ${transition.job.status} result for job ${id}`);
    }
    const savedJob = transition.job;
    await this.jobRunnerService.cancel(id);
    this.jobRunnerService.trackCompletionNotification(savedJob);
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

    let jobToCancel = job;
    let runnerCancelAlreadyRequested = false;
    if (job.executionMode === 'tmux' && job.status === 'running' && job.session) {
      runnerCancelAlreadyRequested = true;
      const cancelled = await this.jobRunnerService.cancel(id);
      if (!cancelled) {
        throw new ConflictException(`Job ${id} tmux session could not be cancelled`);
      }
      jobToCancel = await this.getJobOrThrow(id);
    }

    const transition = await this.repository.transition(id, ['queued', 'running'], (current) => ({
      ...current,
      ...(jobToCancel.session ? { session: jobToCancel.session } : {}),
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      exitCode: current.exitCode ?? null,
      stderr: current.stderr || 'Cancelled by API request',
      execution: { ...current.execution, errorType: 'cancelled' },
    }));
    if (!transition.job) throw new NotFoundException(`Job ${id} not found`);
    if (!transition.transitioned) {
      if (transition.job.status === 'cancelled') return transition.job;
      throw new ConflictException(`Job ${id} is already ${transition.job.status}`);
    }
    const savedJob = transition.job;
    if (!runnerCancelAlreadyRequested) {
      await this.jobRunnerService.cancel(id);
    }
    this.jobRunnerService.trackCompletionNotification(savedJob);
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

  private isEquivalentCallbackReplay(job: BridgeJob, input: JobCallbackDto): boolean {
    if (job.status !== input.status) return false;
    if (Object.prototype.hasOwnProperty.call(input, 'stdout') && job.stdout !== input.stdout) return false;
    if (Object.prototype.hasOwnProperty.call(input, 'stderr') && job.stderr !== input.stderr) return false;
    if (Object.prototype.hasOwnProperty.call(input, 'exitCode') && job.exitCode !== input.exitCode) return false;
    const execution = input.execution;
    if (!execution) return true;
    for (const key of ['durationMs', 'timedOut', 'outputTruncated', 'errorType'] as const) {
      if (Object.prototype.hasOwnProperty.call(execution, key) && job.execution[key] !== execution[key]) {
        return false;
      }
    }
    return true;
  }

  private isTerminal(status: JobStatus): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
  }

  private normalizeLegacySource(input: CreateJobDto): CreateJobDto {
    const source = input.source as CreateJobDto['source'] | 'synapse';
    if (source !== 'synapse') {
      return input;
    }

    return {
      ...input,
      source: 'channel',
      sourceName: input.sourceName ?? 'claude-synapse',
    };
  }

  private async findExistingRequestJob(input: CreateJobDto): Promise<BridgeJob | null> {
    if (!input.requestId) {
      return null;
    }

    const jobs = await this.repository.listAll();
    return jobs.find((job) =>
      job.requestId === input.requestId &&
      job.source === input.source
    ) ?? null;
  }

  private buildRequestFingerprint(input: CreateJobDto): string | undefined {
    if (!input.requestId) {
      return undefined;
    }

    return this.buildRequestFingerprintFromPayload(input, true);
  }

  private buildRequestFingerprintFromPayload(
    input: Pick<CreateJobDto, 'prompt' | 'executionMode' | 'cwd' | 'notifyUrl' | 'originRoutingKey' | 'source' | 'sourceName' | 'metadata'>,
    includeExecutionMode: boolean,
  ): string {
    return this.hashStableJson({
      prompt: input.prompt,
      ...(includeExecutionMode ? { executionMode: input.executionMode ?? 'exec' } : {}),
      cwd: input.cwd,
      notifyUrl: input.notifyUrl,
      originRoutingKey: input.originRoutingKey,
      source: input.source,
      sourceName: input.sourceName,
      metadata: input.metadata,
    });
  }

  private assertRequestFingerprintMatches(
    existingJob: BridgeJob,
    incomingInput: CreateJobDto,
  ): void {
    if (!existingJob.requestId || !incomingInput.requestId) {
      return;
    }

    const existingPayload = {
      prompt: existingJob.prompt,
      executionMode: existingJob.executionMode,
      cwd: existingJob.cwd,
      notifyUrl: existingJob.notifyUrl,
      originRoutingKey: existingJob.originRoutingKey,
      source: existingJob.source,
      sourceName: existingJob.sourceName,
      metadata: existingJob.metadata,
    };
    const incomingCurrentFingerprint = this.buildRequestFingerprintFromPayload(incomingInput, true);
    const existingCurrentFingerprint = this.buildRequestFingerprintFromPayload(existingPayload, true);
    if (
      existingJob.requestFingerprint === incomingCurrentFingerprint ||
      existingCurrentFingerprint === incomingCurrentFingerprint
    ) {
      return;
    }

    const incomingLegacyFingerprint = this.buildRequestFingerprintFromPayload(incomingInput, false);
    const existingLegacyFingerprint = this.buildRequestFingerprintFromPayload(existingPayload, false);
    const existingMode = existingJob.executionMode ?? 'exec';
    const incomingMode = incomingInput.executionMode ?? 'exec';
    const storedFingerprintAllowsLegacyMatch =
      !existingJob.requestFingerprint ||
      existingJob.requestFingerprint === existingLegacyFingerprint;
    if (
      existingMode === incomingMode &&
      storedFingerprintAllowsLegacyMatch &&
      incomingLegacyFingerprint === existingLegacyFingerprint
    ) {
      return;
    }

    throw new ConflictException(
      `requestId ${existingJob.requestId} for source ${existingJob.source ?? 'default'} ` +
        'already belongs to a different job payload',
    );
  }

  private hashStableJson(value: unknown): string {
    return createHash('sha256')
      .update(this.stableStringify(value))
      .digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`);
      return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  private nextQueueOrder(): string {
    // {ms}-{seq}: ms는 unix epoch millis(현재 13자리), seq는 동일 ms 내 tie-breaker.
    // 프로세스 재시작 시 seq가 0으로 리셋되지만 listAll의 createdAt/id 보조 정렬이
    // 동일 (ms,seq) 충돌을 안정적으로 풀어준다.
    this.queueSequence += 1;
    return `${Date.now()}-${this.queueSequence.toString().padStart(6, '0')}`;
  }

  private async assertAllowedCwd(cwd: string | undefined): Promise<string | undefined> {
    try {
      return await resolveAllowedExecutionCwd(cwd, this.config.allowedCwdPrefixes);
    } catch (error) {
      if (!(error instanceof CwdBoundaryError)) {
        throw error;
      }
      throw new HttpException(
        error.message,
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
