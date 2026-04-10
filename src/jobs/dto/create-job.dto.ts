import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export const MAX_PROMPT_LENGTH = 4000;

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
  @IsObject()
  metadata?: Record<string, unknown>;
}
