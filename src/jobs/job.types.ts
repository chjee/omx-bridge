export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobExecutionMetadata {
  command: string;
  timeoutMs: number;
  maxOutputChars: number;
  durationMs?: number;
  timedOut?: boolean;
  outputTruncated?: boolean;
  errorType?: 'spawn_error' | 'timeout' | 'non_zero_exit';
  recoveredFromRestart?: boolean;
}

export interface BridgeJob {
  id: string;
  prompt: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  execution: JobExecutionMetadata;
}

export interface OmxExecutionResult {
  status: 'succeeded' | 'failed';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  execution: JobExecutionMetadata;
}
