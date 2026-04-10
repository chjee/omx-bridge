import { Inject, Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import type { BridgeJob } from './job.types';

@Injectable()
export class TelegramNotifyService {
  private readonly logger = new Logger(TelegramNotifyService.name);

  constructor(@Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig) {}

  async notifyJobComplete(job: BridgeJob): Promise<void> {
    await this.notifyOpenClawHooks(job);
    await this._sendTelegram(job);
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
