import { ConfigService } from '@nestjs/config';
import path from 'node:path';

export type NotifyMode = 'openclaw' | 'claude';

export interface BridgeConfig {
  jobsDirectory: string;
  omxCommand: string;
  jobPollIntervalMs: number;
  jobTimeoutMs: number;
  maxOutputChars: number;
  /** SIGTERM 후 SIGKILL을 보내기까지 대기 시간 (ms) */
  sigkillGraceMs: number;
  /** 동시에 실행할 수 있는 최대 잡 수 (기본 2). CLI/Telegram 동시 제출 시 한쪽이 다른 쪽을 막지 않게 함. */
  maxConcurrency: number;
  /** 완료 webhook 재시도 간격 (ms). 배열 길이 + 1 만큼 시도. */
  notifyRetryDelaysMs?: number[];
  /** 콜백 시참 서명 검증에 사용하는 HMAC 시크릿 (undefined 시 인증 없이 허용) */
  callbackSecret?: string;
  /**
   * Bearer 토큰: POST /jobs, GET /jobs[/:id], POST /jobs/:id/cancel 보호.
   * undefined 시 가드 비활성(기본). 외부 호스트 노출 시 반드시 설정 권장.
   * /callback은 callbackSecret 기반 HMAC을 별도 사용하므로 영향 없음.
   */
  apiToken?: string;
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

export function buildBridgeConfig(
  configService: ConfigService,
  cwd: string = process.cwd(),
): BridgeConfig {
  const rawNotifyMode = configService.get<string>('NOTIFY_MODE', 'openclaw');
  const notifyMode: NotifyMode = rawNotifyMode === 'claude' ? 'claude' : 'openclaw';

  return {
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
    notifyRetryDelaysMs: parsePositiveIntList(
      configService.get<string>('BRIDGE_NOTIFY_RETRY_DELAYS_MS'),
      [500, 1_000, 2_000],
    ),
    callbackSecret: configService.get<string>('BRIDGE_CALLBACK_SECRET') || undefined,
    apiToken: configService.get<string>('BRIDGE_API_TOKEN') || undefined,
    notifyMode,
    claudeNotifyUrl: configService.get<string>('CLAUDE_NOTIFY_URL') || undefined,
    ...(configService.get<string>('OPENCLAW_HOOKS_URL')
      ? {
          openclawHooks: {
            url: configService.get<string>('OPENCLAW_HOOKS_URL')!,
            token: configService.get<string>('OPENCLAW_HOOKS_TOKEN')!,
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
