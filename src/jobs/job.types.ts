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
  errorType?: 'spawn_error' | 'timeout' | 'non_zero_exit' | 'cancelled' | 'execution_error' | 'invalid_cwd';
  recoveredFromRestart?: boolean;
}

export type JobSource = 'dispatch' | 'channel' | 'synapse' | 'openclaw';

export type NotifyChannelStatus = 'ok' | 'failed' | 'skipped';

export interface NotifyChannelResult {
  status: NotifyChannelStatus;
  /** 'failed' 시 짧은 사유 코드(예: 'http_500', 'fetch_error') */
  error?: string;
  /** 'failed' 시 마지막 HTTP 응답 상태 코드(존재 시) */
  httpStatus?: number;
  /** 전송 시도 횟수. retry가 있는 채널에서 기록된다. */
  attempts?: number;
  /** 'skipped' 시 사유(예: 'not_configured', 'broker_fallback', 'webhook_ok') */
  skippedReason?: string;
}

export interface NotifyOutcome {
  attemptedAt: string;
  mode: 'openclaw' | 'claude';
  trigger?: 'auto' | 'manual';
  attemptIndex?: number;
  claudeWebhook?: NotifyChannelResult;
  openclaw?: NotifyChannelResult;
  telegram?: NotifyChannelResult;
}

export interface BridgeJob {
  id: string;
  prompt: string;
  cwd?: string;
  queueOrder: string;
  requestId?: string;
  requestFingerprint?: string;
  originRoutingKey?: string;
  source?: JobSource;
  sourceName?: string;
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
  notifyOutcome?: NotifyOutcome;
  /** 최근 10개 완료 알림 시도 이력 */
  notifyHistory?: NotifyOutcome[];
}

export interface OmxExecutionResult {
  status: TerminalJobStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  execution: JobExecutionMetadata;
}
