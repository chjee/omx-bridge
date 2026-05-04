import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import { Buffer } from 'node:buffer';

export const MAX_PROMPT_LENGTH = 4000;
export const MAX_METADATA_BYTES = 8192;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function IsLoopbackNotifyUrl(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isLoopbackNotifyUrl',
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;

          try {
            const url = new URL(value);
            return LOOPBACK_HOSTS.has(url.hostname);
          } catch {
            return false;
          }
        },
        defaultMessage(): string {
          return 'notifyUrl must target a loopback host';
        },
      },
    },
    validationOptions,
  );
}

function MaxJsonByteLength(maxBytes: number, validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'maxJsonByteLength',
      constraints: [maxBytes],
      validator: {
        validate(value: unknown): boolean {
          try {
            const serialized = JSON.stringify(value);
            return typeof serialized === 'string' &&
              Buffer.byteLength(serialized, 'utf8') <= maxBytes;
          } catch {
            return false;
          }
        },
        defaultMessage(): string {
          return `metadata must serialize to ${maxBytes} bytes or less`;
        },
      },
    },
    validationOptions,
  );
}

export class CreateJobDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROMPT_LENGTH)
  prompt!: string;

  @IsOptional()
  @IsString()
  @IsIn(['exec', 'tmux'])
  executionMode?: 'exec' | 'tmux';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cwd?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  originRoutingKey?: string;

  @IsOptional()
  @IsString()
  @IsIn(['dispatch', 'channel', 'synapse', 'openclaw'])
  source?: 'dispatch' | 'channel' | 'synapse' | 'openclaw';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourceName?: string;

  @IsOptional()
  @IsObject()
  @MaxJsonByteLength(MAX_METADATA_BYTES)
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] })
  @IsLoopbackNotifyUrl()
  @MaxLength(500)
  notifyUrl?: string;
}
