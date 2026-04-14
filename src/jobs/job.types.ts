export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type TerminalJobStatus = Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>;

export interface JobExecutionMetadata {
  command: string;
  timeoutMs: number;
  maxOutputChars: number;
  durationMs?: number;
  timedOut?: boolean;
  outputTruncated?: boolean;
  errorType?: 'spawn_error' | 'timeout' | 'non_zero_exit' | 'cancelled';
  recoveredFromRestart?: boolean;
}

export interface BridgeJob {
  id: string;
  prompt: string;
  cwd?: string;
  queueOrder: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  notifyUrl?: string;
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
  status: TerminalJobStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  execution: JobExecutionMetadata;
}
