import { ConfigService } from '@nestjs/config';
import os from 'node:os';
import path from 'node:path';

export type NotifyMode = 'openclaw' | 'claude';

export interface BridgeConfig {
  host: string;
  jobsDirectory: string;
  omxCommand: string;
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
  /** 콜백 시참 서명 검증에 사용하는 HMAC 시크릿 (undefined 시 인증 없이 허용) */
  callbackSecret?: string;
  /**
   * Bearer 토큰: POST /jobs, GET /jobs[/:id], POST /jobs/:id/cancel 보호.
   * undefined 시 가드 비활성(기본). 외부 호스트 노출 시 반드시 설정 권장.
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

  if (openclawHooksUrl && !openclawHooksToken) {
    throw new Error('OPENCLAW_HOOKS_TOKEN is required when OPENCLAW_HOOKS_URL is set');
  }
  if (!isLoopbackHost(host) && !apiToken) {
    throw new Error('BRIDGE_API_TOKEN is required when BRIDGE_HOST is not loopback');
  }
  if (!isLoopbackHost(host) && !callbackSecret) {
    throw new Error('BRIDGE_CALLBACK_SECRET is required when BRIDGE_HOST is not loopback');
  }

  return {
    host,
    jobsDirectory: configService.get<string>(
      'BRIDGE_JOBS_DIR',
      path.join(cwd, '.omx', 'state', 'bridge-jobs'),
    ),
    omxCommand: configService.get<string>('OMX_COMMAND', 'omx'),
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
