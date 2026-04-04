import { IsIn, IsOptional } from 'class-validator';
import { JOB_STATUSES, type JobStatus } from '../job.types';

export class ListJobsDto {
  @IsOptional()
  @IsIn(JOB_STATUSES)
  status?: JobStatus;
}
