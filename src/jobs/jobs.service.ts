import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import type { CreateJobDto } from './dto/create-job.dto';
import type { JobCallbackDto } from './dto/job-callback.dto';
import { JobQueueRepository } from './job-queue.repository';
import { JobRunnerService } from './job-runner.service';
import type { BridgeJob, JobStatus } from './job.types';

@Injectable()
export class JobsService {
  private queueSequence = 0;

  constructor(
    private readonly repository: JobQueueRepository,
    private readonly jobRunnerService: JobRunnerService,
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
  ) {}

  async createJob(input: CreateJobDto): Promise<BridgeJob> {
    const job: BridgeJob = {
      id: randomUUID(),
      prompt: input.prompt,
      cwd: input.cwd,
      queueOrder: this.nextQueueOrder(),
      requestId: input.requestId,
      metadata: input.metadata,
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

    return this.repository.create(job);
  }

  async listJobs(status?: JobStatus): Promise<BridgeJob[]> {
    if (status) {
      return this.repository.listByStatus(status);
    }

    return this.repository.listAll();
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
      throw new ConflictException(`Job ${id} is already ${job.status}`);
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
        ...(input.execution ?? {}),
      },
    });
    await this.jobRunnerService.cancel(id);
    return savedJob;
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

  private isTerminal(status: JobStatus): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
  }

  private nextQueueOrder(): string {
    this.queueSequence += 1;
    return `${Date.now().toString().padStart(13, '0')}-${this.queueSequence
      .toString()
      .padStart(6, '0')}`;
  }
}
