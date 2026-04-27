import { Inject, Injectable, Logger } from '@nestjs/common';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import { computeCallbackSignature } from './callback-signature';
import { JobQueueRepository } from './job-queue.repository';
import type {
  BridgeJob,
  NotifyChannelResult,
  NotifyOutcome,
} from './job.types';

const DEFAULT_NOTIFY_RETRY_DELAYS_MS = [500, 1_000, 2_000];

interface NotifyOptions {
  trigger?: 'auto' | 'manual';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

@Injectable()
export class JobNotifyService {
  private readonly logger = new Logger(JobNotifyService.name);

  constructor(
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
    private readonly repository: JobQueueRepository,
  ) {}

  async notifyJobComplete(job: BridgeJob, options?: NotifyOptions): Promise<NotifyOutcome> {
    const outcome: NotifyOutcome = {
      attemptedAt: new Date().toISOString(),
      mode: this.config.notifyMode,
      trigger: options?.trigger ?? 'auto',
    };

    if (this.config.notifyMode === 'claude') {
      outcome.claudeWebhook = await this._notifyClaudeWebhook(job);
      outcome.telegram = await this._maybeSendTelegramFallback(job, outcome.claudeWebhook);
    } else {
      const [openclaw, telegram] = await Promise.all([
        this._notifyOpenClawHooks(job),
        this._sendTelegram(job),
      ]);
      outcome.openclaw = openclaw;
      outcome.telegram = telegram;
    }

    return this.persistOutcome(job.id, outcome);
  }

  private async persistOutcome(jobId: string, outcome: NotifyOutcome): Promise<NotifyOutcome> {
    const latest = await this.repository.getById(jobId);
    if (!latest) return outcome;
    const attemptIndex = latest.notifyHistory?.length ?? 0;
    const outcomeWithIndex = { ...outcome, attemptIndex };
    const updatedHistory = [...(latest.notifyHistory ?? []), outcomeWithIndex].slice(-10);
    try {
      await this.repository.save({
        ...latest,
        notifyOutcome: outcomeWithIndex,
        notifyHistory: updatedHistory,
      });
    } catch (err) {
      this.logger.warn(`Failed to persist notifyOutcome for ${jobId}: ${String(err)}`);
    }
    return outcomeWithIndex;
  }

  private async _notifyClaudeWebhook(job: BridgeJob): Promise<NotifyChannelResult> {
    const notifyUrl = job.notifyUrl ?? this.config.claudeNotifyUrl;
    if (!notifyUrl) {
      this.logger.warn('NOTIFY_MODE=claude 이지만 CLAUDE_NOTIFY_URL이 설정되지 않았습니다.');
      return { status: 'skipped', skippedReason: 'no_notify_url' };
    }

    const payload: BridgeJob = {
      ...job,
      stdout: job.stdout?.slice(0, 2000) || '',
      stderr: job.stderr?.slice(0, 500) || '',
    };
    const body = JSON.stringify(payload);

    const retryDelays = this.config.notifyRetryDelaysMs ?? DEFAULT_NOTIFY_RETRY_DELAYS_MS;
    let lastResult: NotifyChannelResult = { status: 'failed', error: 'unknown_error', attempts: 0 };
    for (let attempt = 1; attempt <= retryDelays.length + 1; attempt += 1) {
      try {
        const response = await fetchWithTimeout(notifyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.callbackSecret
              ? { 'X-Callback-Signature': computeCallbackSignature(job.id, body, this.config.callbackSecret) }
              : {}),
          },
          body,
        }, this.config.notifyTimeoutMs);
        if (!response.ok) {
          lastResult = {
            status: 'failed',
            error: `http_${response.status}`,
            httpStatus: response.status,
            attempts: attempt,
          };
        } else {
          return { status: 'ok', attempts: attempt };
        }
      } catch (err) {
        lastResult = {
          status: 'failed',
          error: this.isAbortError(err) ? 'timeout' : 'fetch_error',
          attempts: attempt,
        };
      }

      const nextDelay = retryDelays[attempt - 1];
      if (nextDelay !== undefined) {
        await sleep(nextDelay);
      }
    }

    this.logger.warn(
      `Claude webhook 전송 실패: ${lastResult.error ?? 'unknown_error'} after ${lastResult.attempts ?? 0} attempt(s)`,
    );
    return lastResult;
  }

  private async _maybeSendTelegramFallback(
    job: BridgeJob,
    webhookResult: NotifyChannelResult,
  ): Promise<NotifyChannelResult> {
    if (webhookResult.status === 'ok') {
      return { status: 'skipped', skippedReason: 'webhook_ok' };
    }
    if (job.notifyUrl) {
      return { status: 'skipped', skippedReason: 'per_job_webhook_failed' };
    }
    if (job.source === 'synapse' || (!job.source && !!job.originRoutingKey)) {
      return { status: 'skipped', skippedReason: 'broker_fallback' };
    }
    return this._sendTelegram(job);
  }

  private async _notifyOpenClawHooks(job: BridgeJob): Promise<NotifyChannelResult> {
    if (!this.config.openclawHooks) {
      return { status: 'skipped', skippedReason: 'not_configured' };
    }
    const { url, token, sessionKey } = this.config.openclawHooks;
    const icon = job.status === 'succeeded' ? '✅' : '❌';
    const detail = job.status === 'failed'
      ? job.stderr?.slice(0, 300) || job.stdout?.slice(0, 300) || ''
      : job.stdout?.slice(0, 300) || '';
    const message = [
      `${icon} omx job ${job.status} (${job.id.slice(0, 8)})`,
      job.cwd ? `Dir: ${job.cwd}` : '',
      detail,
    ].filter(Boolean).join('\n');

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, agentId: 'main', sessionKey, deliver: true }),
      }, this.config.notifyTimeoutMs);
      if (!response.ok) {
        this.logger.warn(`OpenClaw notify 응답 오류: ${response.status} ${response.statusText}`);
        return { status: 'failed', error: `http_${response.status}`, httpStatus: response.status };
      }
      return { status: 'ok' };
    } catch (err) {
      this.logger.warn(`OpenClaw notify 전송 실패: ${String(err)}`);
      return { status: 'failed', error: this.isAbortError(err) ? 'timeout' : 'fetch_error' };
    }
  }

  private async _sendTelegram(job: BridgeJob): Promise<NotifyChannelResult> {
    if (!this.config.telegram) {
      return { status: 'skipped', skippedReason: 'not_configured' };
    }

    const { botToken, chatId } = this.config.telegram;
    const icon = job.status === 'succeeded' ? '✅' : '❌';
    const stdout = job.stdout?.slice(0, 400) || '';
    const text = [
      `${icon} omx job ${job.status}`,
      `ID: ${job.id.slice(0, 8)}...`,
      job.cwd ? `Dir: ${job.cwd}` : '',
      stdout ? `\n${stdout}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const response = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      }, this.config.notifyTimeoutMs);
      if (!response.ok) {
        this.logger.warn(`Telegram notify 응답 오류: ${response.status} ${response.statusText}`);
        return { status: 'failed', error: `http_${response.status}`, httpStatus: response.status };
      }
      return { status: 'ok' };
    } catch (err) {
      this.logger.warn(`Telegram notify 전송 실패: ${String(err)}`);
      return { status: 'failed', error: this.isAbortError(err) ? 'timeout' : 'fetch_error' };
    }
  }

  private isAbortError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError'
    );
  }
}
