import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';

@Injectable()
export class CallbackAuthGuard implements CanActivate {
  constructor(@Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.callbackSecret) {
      // 시크릿 미설정 — 인증 없이 통과 (하위 호환)
      return true;
    }

    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const jobId = req.params['id'] ?? '';
    const signature = req.headers['x-callback-signature'];

    if (typeof signature !== 'string' || !signature.startsWith('sha256=')) {
      throw new UnauthorizedException('Missing or invalid X-Callback-Signature header');
    }

    if (!Buffer.isBuffer(req.rawBody)) {
      throw new UnauthorizedException('Missing raw request body for signature verification');
    }

    const hmac = createHmac('sha256', this.config.callbackSecret);
    hmac.update(`${jobId}:`);
    hmac.update(req.rawBody);
    const expected = hmac.digest('hex');

    const provided = signature.slice('sha256='.length);

    let match = false;
    try {
      match = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
    } catch {
      // 길이 불일치 등 — 서명 검증 실패
      match = false;
    }

    if (!match) {
      throw new UnauthorizedException('Invalid callback signature');
    }

    return true;
  }
}
