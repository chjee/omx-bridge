import { ConfigService } from '@nestjs/config';
import path from 'node:path';

export interface BridgeConfig {
  jobsDirectory: string;
  omxCommand: string;
  jobPollIntervalMs: number;
  jobTimeoutMs: number;
  maxOutputChars: number;
  /** 콜백 시참 서명 검증에 사용하는 HMAC 시크릿 (undefined 시 인증 없이 허용) */
  callbackSecret?: string;
  /** 텔레그램 알림 설정 */
  telegram?: {
    botToken: string;
    chatId: string;
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

export function buildBridgeConfig(
  configService: ConfigService,
  cwd: string = process.cwd(),
): BridgeConfig {
  return {
    jobsDirectory: configService.get<string>(
      'BRIDGE_JOBS_DIR',
      path.join(cwd, '.omx', 'state', 'bridge-jobs'),
    ),
    omxCommand: configService.get<string>('OMX_COMMAND', 'omx'),
    jobPollIntervalMs: parsePositiveInt(
      configService.get<string>('BRIDGE_JOB_POLL_INTERVAL_MS'),
      100,
    ),
    jobTimeoutMs: parsePositiveInt(
      configService.get<string>('BRIDGE_JOB_TIMEOUT_MS'),
      15 * 60 * 1000,
    ),
    maxOutputChars: parsePositiveInt(
      configService.get<string>('BRIDGE_MAX_OUTPUT_CHARS'),
      32_000,
    ),
    callbackSecret: configService.get<string>('BRIDGE_CALLBACK_SECRET') || undefined,
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
