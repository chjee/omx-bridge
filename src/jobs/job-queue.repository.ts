import { Inject, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import type { BridgeJob, JobStatus } from './job.types';

@Injectable()
export class JobQueueRepository {
  private readonly logger = new Logger(JobQueueRepository.name);

  constructor(
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
  ) {}

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.config.jobsDirectory, { recursive: true });
  }

  async create(job: BridgeJob): Promise<BridgeJob> {
    await this.writeJob(job);
    return job;
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
        if (left.createdAt === right.createdAt) {
          return left.id.localeCompare(right.id);
        }
        return left.createdAt.localeCompare(right.createdAt);
      });
  }

  async listByStatus(status: JobStatus): Promise<BridgeJob[]> {
    const jobs = await this.listAll();
    return jobs.filter((job) => job.status === status);
  }

  private jobPath(id: string): string {
    return path.join(this.config.jobsDirectory, `${id}.json`);
  }

  private async writeJob(job: BridgeJob): Promise<void> {
    await this.ensureReady();
    const targetPath = this.jobPath(job.id);
    const tempPath = `${targetPath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, targetPath);
  }

  private parseJob(raw: string, jobId: string): BridgeJob | null {
    try {
      return JSON.parse(raw) as BridgeJob;
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
}
