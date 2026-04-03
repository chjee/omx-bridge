import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import type { CreateJobDto } from './dto/create-job.dto';
import { JobQueueRepository } from './job-queue.repository';
import type { BridgeJob } from './job.types';

@Injectable()
export class JobsService {
  constructor(
    private readonly repository: JobQueueRepository,
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
  ) {}

  async createJob(input: CreateJobDto): Promise<BridgeJob> {
    const job: BridgeJob = {
      id: randomUUID(),
      prompt: input.prompt,
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

  async getJobOrThrow(id: string): Promise<BridgeJob> {
    const job = await this.repository.getById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    return job;
  }
}
