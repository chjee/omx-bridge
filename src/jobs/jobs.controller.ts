import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CreateJobDto } from './dto/create-job.dto';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async createJob(@Body() body: CreateJobDto): Promise<{ jobId: string; status: string }> {
    const job = await this.jobsService.createJob(body);
    return {
      jobId: job.id,
      status: job.status,
    };
  }

  @Get(':id')
  async getJob(@Param('id') id: string) {
    return this.jobsService.getJobOrThrow(id);
  }
}
