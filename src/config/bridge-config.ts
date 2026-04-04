import { ConfigService } from '@nestjs/config';
import path from 'node:path';

export interface BridgeConfig {
  jobsDirectory: string;
  omxCommand: string;
  jobPollIntervalMs: number;
  jobTimeoutMs: number;
  maxOutputChars: number;
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
  };
}
