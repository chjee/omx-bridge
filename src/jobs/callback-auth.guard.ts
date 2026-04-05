/**
 * CallbackAuthGuard
 *
 * Fix: 콜백 인증 — BRIDGE_CALLBACK_SECRET 환경변수가 설정된 경우
 * X-Callback-Signature 헤더의 HMAC-SHA256 서명을 검증합니다.
 *
 * 서명 방식:
 *   X-Callback-Signature: sha256=<hex>
 *   HMAC 입력: `${jobId}:${JSON.stringify(body)}`
 *
 * BRIDGE_CALLBACK_SECRET이 미설정이면 모든 콜백을 허용합니다.
 * (하위 호환성 — 시크릿 미설정 환경에서 기존 동작 유지)
 */
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

    const req = context.switchToHttp().getRequest<Request>();
    const jobId = req.params['id'] ?? '';
    const signature = req.headers['x-callback-signature'];

    if (typeof signature !== 'string' || !signature.startsWith('sha256=')) {
      throw new UnauthorizedException('Missing or invalid X-Callback-Signature header');
    }

    const rawBody: string =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const expected = createHmac('sha256', this.config.callbackSecret)
      .update(`${jobId}:${rawBody}`)
      .digest('hex');

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
