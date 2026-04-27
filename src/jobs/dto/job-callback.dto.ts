import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JOB_STATUSES, type JobExecutionMetadata, type TerminalJobStatus } from '../job.types';

const TERMINAL_JOB_STATUSES = JOB_STATUSES.filter(
  (status): status is TerminalJobStatus => status !== 'queued' && status !== 'running',
);

const EXECUTION_ERROR_TYPES: JobExecutionMetadata['errorType'][] = [
  'spawn_error', 'timeout', 'non_zero_exit', 'cancelled', 'execution_error',
];

export class JobCallbackExecutionDto {
  @IsOptional()
  @IsInt()
  durationMs?: number;

  @IsOptional()
  @IsBoolean()
  timedOut?: boolean;

  @IsOptional()
  @IsBoolean()
  outputTruncated?: boolean;

  @IsOptional()
  @IsIn(EXECUTION_ERROR_TYPES)
  errorType?: JobExecutionMetadata['errorType'];
}

export class JobCallbackDto {
  @IsIn(TERMINAL_JOB_STATUSES)
  status!: TerminalJobStatus;

  @IsOptional()
  @IsString()
  @MaxLength(32_000)
  stdout?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32_000)
  stderr?: string;

  @IsOptional()
  @IsInt()
  exitCode?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => JobCallbackExecutionDto)
  execution?: JobCallbackExecutionDto;
}
