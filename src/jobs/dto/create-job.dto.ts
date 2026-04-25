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

export const MAX_PROMPT_LENGTH = 4000;

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

export class CreateJobDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROMPT_LENGTH)
  prompt!: string;

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
  @IsIn(['dispatch', 'synapse', 'openclaw'])
  source?: 'dispatch' | 'synapse' | 'openclaw';

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] })
  @IsLoopbackNotifyUrl()
  @MaxLength(500)
  notifyUrl?: string;
}
