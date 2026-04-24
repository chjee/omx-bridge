import { Inject, Injectable, Logger } from '@nestjs/common';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import { computeCallbackSignature } from './callback-signature';
import type { BridgeJob } from './job.types';

@Injectable()
export class JobNotifyService {
  private readonly logger = new Logger(JobNotifyService.name);

  constructor(@Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig) {}

  async notifyJobComplete(job: BridgeJob): Promise<void> {
    if (this.config.notifyMode === 'claude') {
      const delivered = await this._notifyClaudeWebhook(job);
      if (!delivered && !job.originRoutingKey) {
        // originRoutingKey가 있으면 synapse가 routing 담당 — 고정 Telegram fallback 생략
        // originRoutingKey 없는 경우(legacy MCP/resident)는 기존 Telegram fallback 유지
        await this._sendTelegram(job);
      }
      return;
    }

    await Promise.allSettled([
      this.notifyOpenClawHooks(job),
      this._sendTelegram(job),
    ]);
  }

  private async _notifyClaudeWebhook(job: BridgeJob): Promise<boolean> {
    const notifyUrl = job.notifyUrl ?? this.config.claudeNotifyUrl;
    if (!notifyUrl) {
      this.logger.warn('NOTIFY_MODE=claude 이지만 CLAUDE_NOTIFY_URL이 설정되지 않았습니다.');
      return false;
    }

    const payload: BridgeJob = {
      ...job,
      stdout: job.stdout?.slice(0, 2000) || '',
      stderr: job.stderr?.slice(0, 500) || '',
    };
    const body = JSON.stringify(payload);

    try {
      const response = await fetch(notifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.callbackSecret
            ? { 'X-Callback-Signature': computeCallbackSignature(job.id, body, this.config.callbackSecret) }
            : {}),
        },
        body,
      });
      if (!response.ok) {
        this.logger.warn(`Claude webhook 응답 오류: ${response.status} ${response.statusText}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Claude webhook 전송 실패: ${String(err)}`);
      return false;
    }
  }

  private async notifyOpenClawHooks(job: BridgeJob): Promise<void> {
    if (!this.config.openclawHooks) return;
    const { url, token, sessionKey } = this.config.openclawHooks;
    const icon = job.status === 'succeeded' ? '✅' : '❌';
    const message = [
      `${icon} omx job ${job.status} (${job.id.slice(0, 8)})`,
      job.cwd ? `Dir: ${job.cwd}` : '',
      job.stdout?.slice(0, 300) || '',
    ].filter(Boolean).join('\n');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, agentId: 'main', sessionKey, deliver: true }),
      });
      if (!response.ok) {
        this.logger.warn(`OpenClaw notify 응답 오류: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      this.logger.warn(`OpenClaw notify 전송 실패: ${String(err)}`);
    }
  }

  private async _sendTelegram(job: BridgeJob): Promise<void> {
    if (!this.config.telegram) return;

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
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!response.ok) {
        this.logger.warn(`Telegram notify 응답 오류: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      this.logger.warn(`Telegram notify 전송 실패: ${String(err)}`);
    }
  }
}
