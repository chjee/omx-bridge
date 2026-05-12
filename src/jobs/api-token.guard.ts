import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';

/**
 * Bearer-token guard for bridge API routes (non-callback).
 *
 * Pairs with BRIDGE_API_TOKEN. Guarded routes require:
 *
 *     Authorization: Bearer <BRIDGE_API_TOKEN>
 *
 * The /callback route is intentionally NOT guarded by this — callbacks
 * carry their own HMAC signature via CallbackAuthGuard, a different
 * concern (binds to body bytes, not just identity).
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(@Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.apiToken && this.config.insecureLoopback) {
      return true;
    }
    if (!this.config.apiToken) {
      throw new UnauthorizedException('BRIDGE_API_TOKEN is not configured');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const provided = header.slice('Bearer '.length);
    const expected = this.config.apiToken;
    const providedBuf = Buffer.from(provided, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (providedBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException('Invalid API token');
    }
    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      throw new UnauthorizedException('Invalid API token');
    }

    return true;
  }
}
