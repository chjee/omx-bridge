import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import type { BridgeJob } from './job.types';

@Injectable()
export class TelegramNotifyService {
  private readonly logger = new Logger(TelegramNotifyService.name);

  constructor(@Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig) {}

  async notifyJobComplete(job: BridgeJob): Promise<void> {
    if (this.config.notifyMode === 'claude') {
      await Promise.allSettled([
        this._notifyClaudeWebhook(job),
        this._sendTelegram(job),
      ]);
    } else {
      await this.notifyOpenClawHooks(job);
      await this._sendTelegram(job);
    }
  }

  /**
   * claude 모드: CLAUDE_NOTIFY_URL로 완료 이벤트 webhook POST.
   * omx-bridge-mcp 채널 엔드포인트가 수신해서 Claude에 push한다.
   */
  private async _notifyClaudeWebhook(job: BridgeJob): Promise<void> {
    const notifyUrl = job.notifyUrl ?? this.config.claudeNotifyUrl;
    if (!notifyUrl) {
      this.logger.warn('NOTIFY_MODE=claude 이지만 CLAUDE_NOTIFY_URL이 설정되지 않았습니다.');
      return;
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
            ? { 'X-Callback-Signature': this.buildCallbackSignatureHeader(job.id, payload) }
            : {}),
        },
        body,
      });
      if (!response.ok) {
        this.logger.warn(`Claude webhook 응답 오류: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      this.logger.warn(`Claude webhook 전송 실패: ${String(err)}`);
    }
  }

  private buildCallbackSignatureHeader(jobId: string, body: unknown): string {
    const message = `${jobId}:${JSON.stringify(body)}`;
    const hex = createHmac('sha256', this.config.callbackSecret!).update(message).digest('hex');
    return `sha256=${hex}`;
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
      await new Promise<void>((resolve) => {
        const body = JSON.stringify({ message, agentId: 'main', sessionKey, deliver: true });
        const child = spawn('curl', [
          '-s', '-o', '/dev/null',
          '-X', 'POST', url,
          '-H', `Authorization: Bearer ${token}`,
          '-H', 'Content-Type: application/json',
          '-d', body,
        ]);
        child.once('close', () => resolve());
        child.once('error', () => resolve());
      });
    } catch { /* best-effort */ }
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
      await new Promise<void>((resolve) => {
        const body = JSON.stringify({ chat_id: chatId, text });
        const child = spawn('curl', [
          '-s', '-o', '/dev/null',
          '-X', 'POST',
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          '-H', 'Content-Type: application/json',
          '-d', body,
        ]);
        child.once('close', (code) => {
          if (code !== 0) this.logger.warn(`Telegram notify curl exited: ${code}`);
          resolve();
        });
        child.once('error', (err) => {
          this.logger.warn(`Telegram notify error: ${String(err)}`);
          resolve();
        });
      });
    } catch (err) {
      this.logger.warn(`Telegram notify error: ${String(err)}`);
    }
  }
}
