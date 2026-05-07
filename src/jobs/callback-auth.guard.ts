import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import { verifyCallbackSignature } from './callback-signature';

@Injectable()
export class CallbackAuthGuard implements CanActivate {
  constructor(@Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.callbackSecret && this.config.insecureLoopback) {
      return true;
    }
    if (!this.config.callbackSecret) {
      throw new UnauthorizedException('BRIDGE_CALLBACK_SECRET is not configured');
    }

    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const jobId = String(req.params['id'] ?? '');
    const signature = req.headers['x-callback-signature'];

    if (typeof signature !== 'string' || !signature.startsWith('sha256=')) {
      throw new UnauthorizedException('Missing or invalid X-Callback-Signature header');
    }

    if (!Buffer.isBuffer(req.rawBody)) {
      throw new UnauthorizedException('Missing raw request body for signature verification');
    }

    if (!verifyCallbackSignature(jobId, req.rawBody, this.config.callbackSecret, signature)) {
      throw new UnauthorizedException('Invalid callback signature');
    }

    return true;
  }
}
