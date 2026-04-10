import { Inject, Injectable, Logger } from '@nestjs/common';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import type { BridgeJob } from './job.types';

@Injectable()
export class TelegramNotifyService {
  private readonly logger = new Logger(TelegramNotifyService.name);

  constructor(@Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig) {}

  async notifyJobComplete(job: BridgeJob): Promise<void> {
    if (!this.config.telegram) {
      return;
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
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      );
      if (!res.ok) {
        this.logger.warn(`Telegram notify failed: ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(`Telegram notify error: ${String(err)}`);
    }
  }
}
