import { ConfigService } from '@nestjs/config';
import os from 'node:os';
import path from 'node:path';

export type NotifyMode = 'openclaw' | 'claude';

export interface BridgeConfig {
  host: string;
  /** Express JSON body parser limit. */
  requestBodyLimit?: string;
  jobsDirectory: string;
  omxCommand: string;
  /** `omx exec --model`에 전달할 Codex 모델 이름. */
  omxModel?: string;
  /** `omx exec -c model_reasoning_effort=...`로 전달할 Codex reasoning effort. */
  omxModelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** tmux 기반 장기 세션을 시작할 때 사용할 바이너리. */
  tmuxCommand: string;
  /** tmux 세션 상태 파일을 저장할 디렉터리. */
  tmuxSessionsDirectory: string;
  /** `omx exec` 자식 프로세스에 전달할 환경 변수 이름 allowlist. */
  omxEnvAllowlist?: string[];
  jobPollIntervalMs: number;
  jobTimeoutMs: number;
  maxOutputChars: number;
  /** SIGTERM 후 SIGKILL을 보내기까지 대기 시간 (ms) */
  sigkillGraceMs: number;
  /** 동시에 실행할 수 있는 최대 잡 수 (기본 2). CLI/Telegram 동시 제출 시 한쪽이 다른 쪽을 막지 않게 함. */
  maxConcurrency: number;
  /** queued + running 잡 허용 상한. 초과 시 POST /jobs를 429로 거절한다. */
  maxActiveJobs: number;
  /** terminal 잡 파일 보존 기간 (일). succeeded/failed/cancelled만 대상. */
  jobRetentionDays: number;
  /** 보존할 terminal 잡 파일 최대 개수. 초과분은 오래된 것부터 삭제. */
  maxTerminalJobs: number;
  /** terminal 잡 파일 정리 주기 (ms). */
  jobCleanupIntervalMs: number;
  /** 완료 webhook 재시도 간격 (ms). 배열 길이 + 1 만큼 시도. */
  notifyRetryDelaysMs?: number[];
  /** 완료 알림 fetch 1회 시도 timeout (ms). 작업 실행 timeout과 별개. */
  notifyTimeoutMs: number;
  /** loopback host에서 토큰/콜백 시크릿이 없는 레거시 로컬 실행을 명시적으로 허용한다. */
  insecureLoopback: boolean;
  /** 콜백 서명 검증에 사용하는 HMAC 시크릿. insecureLoopback이 아니면 필수. */
  callbackSecret?: string;
  /**
   * Bearer 토큰: POST /jobs, GET /jobs[/:id], POST /jobs/:id/cancel 보호.
   * insecureLoopback이 아니면 필수.
   * /callback은 callbackSecret 기반 HMAC을 별도 사용하므로 영향 없음.
   */
  apiToken?: string;
  /** Job cwd가 지정될 때 허용할 절대 경로 prefix 목록. 기본값은 현재 사용자 HOME. */
  allowedCwdPrefixes: string[];
  /**
   * 완료 알림 모드
   * - openclaw: OpenClaw hooks + 텔레그램 직접 전송 (기본값, 현재 운영 중)
   * - claude: claudeNotifyUrl로 webhook POST, Telegram 설정이 있으면 fallback push 병행
   */
  notifyMode: NotifyMode;
  /** claude 모드 전용: 완료 이벤트를 수신할 webhook URL (omx-dispatch 채널 엔드포인트) */
  claudeNotifyUrl?: string;
  /** 텔레그램 알림 설정 (openclaw 직접 알림 또는 claude 모드 fallback push) */
  telegram?: {
    botToken: string;
    chatId: string;
  };
  /** OpenClaw hooks 알림 설정 (openclaw 모드 전용) */
  openclawHooks?: {
    url: string;
    token: string;
    sessionKey: string;
  };
}

export const BRIDGE_CONFIG = Symbol('BRIDGE_CONFIG');
export const DEFAULT_REQUEST_BODY_LIMIT = '1mb';

export const DEFAULT_OMX_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSH_AUTH_SOCK',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OMX_DEFAULT_FRONTIER_MODEL',
  'OMX_DEFAULT_SPARK_MODEL',
  'OMX_DEFAULT_STANDARD_MODEL',
];

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBodyLimit(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }

  return /^\d+(?:b|kb|mb)?$/i.test(trimmed) ? trimmed : fallback;
}

function parsePositiveIntList(value: string | undefined, fallback: number[]): number[] {
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((part) => Number.isFinite(part) && part > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function parseAllowedCwdPrefixes(
  value: string | undefined,
  cwd: string,
  homeDir: string,
): string[] {
  const rawParts = value
    ? value.split(',').map((part) => part.trim()).filter(Boolean)
    : [homeDir];

  const prefixes = rawParts.map((part) => {
    const expanded = part === '~' ? homeDir : part.startsWith('~/') ? path.join(homeDir, part.slice(2)) : part;
    return path.resolve(cwd, expanded);
  });

  return [...new Set(prefixes)];
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length > 0 ? [...new Set(parsed)] : fallback;
}

function parseBoolean(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

function parseModelReasoningEffort(
  value: string | undefined,
): BridgeConfig['omxModelReasoningEffort'] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh') {
    return normalized;
  }

  throw new Error('BRIDGE_OMX_MODEL_REASONING_EFFORT must be one of: low, medium, high, xhigh');
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]';
}

export function buildBridgeConfig(
  configService: ConfigService,
  cwd: string = process.cwd(),
  homeDir: string = os.homedir(),
): BridgeConfig {
  const host = configService.get<string>('BRIDGE_HOST', '127.0.0.1');
  const rawNotifyMode = configService.get<string>('NOTIFY_MODE', 'openclaw');
  const notifyMode: NotifyMode = rawNotifyMode === 'claude' ? 'claude' : 'openclaw';
  const openclawHooksUrl = configService.get<string>('OPENCLAW_HOOKS_URL') || undefined;
  const openclawHooksToken = configService.get<string>('OPENCLAW_HOOKS_TOKEN') || undefined;
  const callbackSecret = configService.get<string>('BRIDGE_CALLBACK_SECRET') || undefined;
  const apiToken = configService.get<string>('BRIDGE_API_TOKEN') || undefined;
  const loopbackHost = isLoopbackHost(host);
  const insecureLoopback = parseBoolean(configService.get<string>('BRIDGE_INSECURE_LOOPBACK'));

  if (openclawHooksUrl && !openclawHooksToken) {
    throw new Error('OPENCLAW_HOOKS_TOKEN is required when OPENCLAW_HOOKS_URL is set');
  }
  if (insecureLoopback && !loopbackHost) {
    throw new Error('BRIDGE_INSECURE_LOOPBACK is only allowed when BRIDGE_HOST is loopback');
  }
  if (!insecureLoopback && !apiToken) {
    throw new Error('BRIDGE_API_TOKEN is required unless BRIDGE_INSECURE_LOOPBACK=1 on a loopback BRIDGE_HOST');
  }
  if (!insecureLoopback && !callbackSecret) {
    throw new Error('BRIDGE_CALLBACK_SECRET is required unless BRIDGE_INSECURE_LOOPBACK=1 on a loopback BRIDGE_HOST');
  }

  return {
    host,
    requestBodyLimit: parseBodyLimit(
      configService.get<string>('BRIDGE_REQUEST_BODY_LIMIT'),
      DEFAULT_REQUEST_BODY_LIMIT,
    ),
    jobsDirectory: configService.get<string>(
      'BRIDGE_JOBS_DIR',
      path.join(cwd, '.omx', 'state', 'bridge-jobs'),
    ),
    omxCommand: configService.get<string>('OMX_COMMAND', 'omx'),
    omxModel: configService.get<string>('BRIDGE_OMX_MODEL')?.trim() || undefined,
    omxModelReasoningEffort: parseModelReasoningEffort(
      configService.get<string>('BRIDGE_OMX_MODEL_REASONING_EFFORT'),
    ),
    tmuxCommand: configService.get<string>('TMUX_COMMAND', 'tmux'),
    tmuxSessionsDirectory: configService.get<string>(
      'BRIDGE_TMUX_SESSIONS_DIR',
      path.join(cwd, '.omx', 'state', 'bridge-sessions'),
    ),
    omxEnvAllowlist: parseStringList(
      configService.get<string>('BRIDGE_OMX_ENV_ALLOWLIST'),
      DEFAULT_OMX_ENV_ALLOWLIST,
    ),
    jobPollIntervalMs: parsePositiveInt(
      configService.get<string>('BRIDGE_JOB_POLL_INTERVAL_MS'),
      500,
    ),
    jobTimeoutMs: parsePositiveInt(
      configService.get<string>('BRIDGE_JOB_TIMEOUT_MS'),
      15 * 60 * 1000,
    ),
    maxOutputChars: parsePositiveInt(
      configService.get<string>('BRIDGE_MAX_OUTPUT_CHARS'),
      32_000,
    ),
    sigkillGraceMs: parsePositiveInt(
      configService.get<string>('BRIDGE_SIGKILL_GRACE_MS'),
      5_000,
    ),
    maxConcurrency: parsePositiveInt(
      configService.get<string>('BRIDGE_MAX_CONCURRENCY'),
      2,
    ),
    maxActiveJobs: parsePositiveInt(
      configService.get<string>('BRIDGE_MAX_ACTIVE_JOBS'),
      50,
    ),
    jobRetentionDays: parsePositiveInt(
      configService.get<string>('BRIDGE_JOB_RETENTION_DAYS'),
      7,
    ),
    maxTerminalJobs: parsePositiveInt(
      configService.get<string>('BRIDGE_MAX_TERMINAL_JOBS'),
      1_000,
    ),
    jobCleanupIntervalMs: parsePositiveInt(
      configService.get<string>('BRIDGE_JOB_CLEANUP_INTERVAL_MS'),
      60 * 60 * 1000,
    ),
    notifyRetryDelaysMs: parsePositiveIntList(
      configService.get<string>('BRIDGE_NOTIFY_RETRY_DELAYS_MS'),
      [500, 1_000, 2_000],
    ),
    notifyTimeoutMs: parsePositiveInt(
      configService.get<string>('BRIDGE_NOTIFY_TIMEOUT_MS'),
      5_000,
    ),
    insecureLoopback,
    callbackSecret,
    apiToken,
    allowedCwdPrefixes: parseAllowedCwdPrefixes(
      configService.get<string>('BRIDGE_ALLOWED_CWD_PREFIXES'),
      cwd,
      homeDir,
    ),
    notifyMode,
    claudeNotifyUrl: configService.get<string>('CLAUDE_NOTIFY_URL') || undefined,
    ...(openclawHooksUrl
      ? {
          openclawHooks: {
            url: openclawHooksUrl,
            token: openclawHooksToken!,
            sessionKey: configService.get<string>('OPENCLAW_HOOKS_SESSION_KEY') || 'agent:main:telegram:direct',
          },
        }
      : {}),
    ...(configService.get<string>('TELEGRAM_BOT_TOKEN') && configService.get<string>('TELEGRAM_NOTIFY_CHAT_ID')
      ? {
          telegram: {
            botToken: configService.get<string>('TELEGRAM_BOT_TOKEN')!,
            chatId: configService.get<string>('TELEGRAM_NOTIFY_CHAT_ID')!,
          },
        }
      : {}),
  };
}
