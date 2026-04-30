import { Inject, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import { JOB_STATUSES, type BridgeJob, type JobStatus } from './job.types';

const TERMINAL_STATUSES = new Set<JobStatus>(['succeeded', 'failed', 'cancelled']);
const JOB_SOURCES = ['dispatch', 'channel', 'synapse', 'openclaw'] as const;
const EXECUTION_ERROR_TYPES = [
  'spawn_error',
  'timeout',
  'non_zero_exit',
  'cancelled',
  'execution_error',
] as const;
const NOTIFY_MODES = ['openclaw', 'claude'] as const;
const NOTIFY_TRIGGERS = ['auto', 'manual'] as const;
const NOTIFY_CHANNEL_STATUSES = ['ok', 'failed', 'skipped'] as const;

export interface CleanupTerminalJobsOptions {
  retentionDays: number;
  maxTerminalJobs: number;
  now?: Date;
}

export interface CleanupTerminalJobsResult {
  deleted: number;
  retained: number;
}

@Injectable()
export class JobQueueRepository {
  private readonly logger = new Logger(JobQueueRepository.name);

  constructor(
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
  ) {}

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.config.jobsDirectory, { recursive: true });
  }

  async save(job: BridgeJob): Promise<BridgeJob> {
    await this.writeJob(job);
    return job;
  }

  async getById(id: string): Promise<BridgeJob | null> {
    try {
      const raw = await fs.readFile(this.jobPath(id), 'utf8');
      return this.parseJob(raw, id);
    } catch (error) {
      if (this.isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  }

  async listAll(): Promise<BridgeJob[]> {
    await this.ensureReady();
    const entries = await fs.readdir(this.config.jobsDirectory, { withFileTypes: true });
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const jobId = entry.name.replace(/\.json$/, '');
          try {
            const raw = await fs.readFile(this.jobPath(jobId), 'utf8');
            return this.parseJob(raw, jobId);
          } catch (error) {
            this.logger.warn(
              `Skipping unreadable job file ${entry.name}: ${this.describeError(error)}`,
            );
            return null;
          }
        }),
    );

    return jobs
      .filter((job): job is BridgeJob => job !== null)
      .sort((left, right) => {
        const lo = left.queueOrder ?? left.createdAt;
        const ro = right.queueOrder ?? right.createdAt;
        if (lo !== ro) {
          return lo.localeCompare(ro);
        }

        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }

        return left.id.localeCompare(right.id);
      });
  }

  async listByStatus(status: JobStatus): Promise<BridgeJob[]> {
    const jobs = await this.listAll();
    return jobs.filter((job) => job.status === status);
  }

  async countActive(): Promise<number> {
    const jobs = await this.listAll();
    return jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  }

  async cleanupTerminalJobs(
    options: CleanupTerminalJobsOptions,
  ): Promise<CleanupTerminalJobsResult> {
    const now = options.now ?? new Date();
    const cutoffMs = now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
    const terminalJobs = (await this.listAll())
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((left, right) => this.terminalSortKey(left).localeCompare(this.terminalSortKey(right)));

    const deleteIds = new Set<string>();
    for (const job of terminalJobs) {
      const terminalAtMs = this.terminalTimestampMs(job);
      if (Number.isFinite(terminalAtMs) && terminalAtMs < cutoffMs) {
        deleteIds.add(job.id);
      }
    }

    const remainingAfterAge = terminalJobs.filter((job) => !deleteIds.has(job.id));
    const overflow = Math.max(0, remainingAfterAge.length - options.maxTerminalJobs);
    for (const job of remainingAfterAge.slice(0, overflow)) {
      deleteIds.add(job.id);
    }

    for (const id of deleteIds) {
      await fs.rm(this.jobPath(id), { force: true });
    }

    return {
      deleted: deleteIds.size,
      retained: terminalJobs.length - deleteIds.size,
    };
  }

  private jobPath(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestException(`Invalid job id: ${id}`);
    }
    return path.join(this.config.jobsDirectory, `${id}.json`);
  }

  private async writeJob(job: BridgeJob): Promise<void> {
    await this.ensureReady();
    const targetPath = this.jobPath(job.id);
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, targetPath);
  }

  private parseJob(raw: string, jobId: string): BridgeJob | null {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!this.isBridgeJob(parsed, jobId)) {
        this.logger.warn(`Skipping invalid job file for ${jobId}`);
        return null;
      }
      return parsed;
    } catch (error) {
      this.logger.warn(
        `Skipping malformed job file for ${jobId}: ${this.describeError(error)}`,
      );
      return null;
    }
  }

  private isMissingFile(error: unknown): error is NodeJS.ErrnoException {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private terminalSortKey(job: BridgeJob): string {
    return `${job.finishedAt ?? job.createdAt}:${job.queueOrder ?? ''}:${job.id}`;
  }

  private terminalTimestampMs(job: BridgeJob): number {
    return Date.parse(job.finishedAt ?? job.createdAt);
  }

  private isBridgeJob(value: unknown, jobId: string): value is BridgeJob {
    if (!this.isRecord(value)) {
      return false;
    }

    const execution = value.execution;
    return (
      value.id === jobId &&
      typeof value.prompt === 'string' &&
      (value.queueOrder === undefined || typeof value.queueOrder === 'string') &&
      (value.cwd === undefined || typeof value.cwd === 'string') &&
      (value.requestId === undefined || typeof value.requestId === 'string') &&
      (value.requestFingerprint === undefined || typeof value.requestFingerprint === 'string') &&
      (value.originRoutingKey === undefined || typeof value.originRoutingKey === 'string') &&
      (value.source === undefined || this.isOneOf(value.source, JOB_SOURCES)) &&
      (value.sourceName === undefined || typeof value.sourceName === 'string') &&
      (value.metadata === undefined || this.isRecord(value.metadata)) &&
      (value.notifyUrl === undefined || typeof value.notifyUrl === 'string') &&
      typeof value.createdAt === 'string' &&
      (value.startedAt === undefined || typeof value.startedAt === 'string') &&
      (value.finishedAt === undefined || typeof value.finishedAt === 'string') &&
      (value.exitCode === undefined || value.exitCode === null || typeof value.exitCode === 'number') &&
      typeof value.stdout === 'string' &&
      typeof value.stderr === 'string' &&
      typeof value.status === 'string' &&
      JOB_STATUSES.includes(value.status as JobStatus) &&
      this.isExecutionMetadata(execution) &&
      (value.notifyOutcome === undefined || this.isNotifyOutcome(value.notifyOutcome)) &&
      (
        value.notifyHistory === undefined ||
        (Array.isArray(value.notifyHistory) && value.notifyHistory.every((entry) => this.isNotifyOutcome(entry)))
      )
    );
  }

  private isExecutionMetadata(value: unknown): boolean {
    if (!this.isRecord(value)) {
      return false;
    }

    return (
      typeof value.command === 'string' &&
      typeof value.timeoutMs === 'number' &&
      typeof value.maxOutputChars === 'number' &&
      (value.durationMs === undefined || typeof value.durationMs === 'number') &&
      (value.timedOut === undefined || typeof value.timedOut === 'boolean') &&
      (value.outputTruncated === undefined || typeof value.outputTruncated === 'boolean') &&
      (value.errorType === undefined || this.isOneOf(value.errorType, EXECUTION_ERROR_TYPES)) &&
      (value.recoveredFromRestart === undefined || typeof value.recoveredFromRestart === 'boolean')
    );
  }

  private isNotifyOutcome(value: unknown): boolean {
    if (!this.isRecord(value)) {
      return false;
    }

    return (
      typeof value.attemptedAt === 'string' &&
      this.isOneOf(value.mode, NOTIFY_MODES) &&
      (value.trigger === undefined || this.isOneOf(value.trigger, NOTIFY_TRIGGERS)) &&
      (value.attemptIndex === undefined || typeof value.attemptIndex === 'number') &&
      (value.claudeWebhook === undefined || this.isNotifyChannelResult(value.claudeWebhook)) &&
      (value.openclaw === undefined || this.isNotifyChannelResult(value.openclaw)) &&
      (value.telegram === undefined || this.isNotifyChannelResult(value.telegram))
    );
  }

  private isNotifyChannelResult(value: unknown): boolean {
    if (!this.isRecord(value)) {
      return false;
    }

    return (
      this.isOneOf(value.status, NOTIFY_CHANNEL_STATUSES) &&
      (value.error === undefined || typeof value.error === 'string') &&
      (value.httpStatus === undefined || typeof value.httpStatus === 'number') &&
      (value.attempts === undefined || typeof value.attempts === 'number') &&
      (value.skippedReason === undefined || typeof value.skippedReason === 'string')
    );
  }

  private isOneOf<const T extends readonly unknown[]>(value: unknown, values: T): value is T[number] {
    return values.includes(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
