import { IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { JOB_STATUSES, type TerminalJobStatus } from '../job.types';

const TERMINAL_JOB_STATUSES = JOB_STATUSES.filter(
  (status): status is TerminalJobStatus => status !== 'queued' && status !== 'running',
);

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
  @IsObject()
  execution?: Record<string, unknown>;
}
