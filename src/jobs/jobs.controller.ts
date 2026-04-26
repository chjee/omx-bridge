import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CreateJobDto } from './dto/create-job.dto';
import { JobCallbackDto } from './dto/job-callback.dto';
import { ListJobsDto } from './dto/list-jobs.dto';
import { JobsService } from './jobs.service';
import { ApiTokenGuard } from './api-token.guard';
import { CallbackAuthGuard } from './callback-auth.guard';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ApiTokenGuard)
  async createJob(@Body() body: CreateJobDto): Promise<{ jobId: string; status: string }> {
    const job = await this.jobsService.createJob(body);
    return {
      jobId: job.id,
      status: job.status,
    };
  }

  @Get()
  @UseGuards(ApiTokenGuard)
  async listJobs(@Query() query: ListJobsDto) {
    return this.jobsService.listJobs(query.status);
  }

  @Get(':id')
  @UseGuards(ApiTokenGuard)
  async getJob(@Param('id') id: string) {
    return this.jobsService.getJobOrThrow(id);
  }

  @Post(':id/callback')
  @UseGuards(CallbackAuthGuard)
  async handleJobCallback(@Param('id') id: string, @Body() body: JobCallbackDto) {
    return this.jobsService.completeJobFromCallback(id, body);
  }

  @Post(':id/cancel')
  @UseGuards(ApiTokenGuard)
  async cancelJob(@Param('id') id: string) {
    return this.jobsService.cancelJob(id);
  }
}
