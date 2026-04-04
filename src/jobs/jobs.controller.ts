import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CreateJobDto } from './dto/create-job.dto';
import { JobCallbackDto } from './dto/job-callback.dto';
import { ListJobsDto } from './dto/list-jobs.dto';
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

  @Get()
  async listJobs(@Query() query: ListJobsDto) {
    return this.jobsService.listJobs(query.status);
  }

  @Get(':id')
  async getJob(@Param('id') id: string) {
    return this.jobsService.getJobOrThrow(id);
  }

  @Post(':id/callback')
  async handleJobCallback(@Param('id') id: string, @Body() body: JobCallbackDto) {
    return this.jobsService.completeJobFromCallback(id, body);
  }

  @Post(':id/cancel')
  async cancelJob(@Param('id') id: string) {
    return this.jobsService.cancelJob(id);
  }
}
