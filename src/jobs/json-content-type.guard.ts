import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class JsonContentTypeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const contentType = req.headers['content-type'];
    const mediaType = typeof contentType === 'string'
      ? contentType.split(';', 1)[0].trim().toLowerCase()
      : '';

    if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
      return true;
    }

    throw new UnsupportedMediaTypeException('Content-Type must be application/json');
  }
}
