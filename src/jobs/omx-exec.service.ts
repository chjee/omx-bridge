import { Inject, Injectable } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import type { JobExecutionMetadata, OmxExecutionResult, TerminalJobStatus } from './job.types';

export type SpawnFunction = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export const OMX_SPAWN = Symbol('OMX_SPAWN');

export interface ExecuteOmxOptions {
  signal?: AbortSignal;
}

@Injectable()
export class OmxExecService {
  constructor(
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
    @Inject(OMX_SPAWN) private readonly spawnFn: SpawnFunction,
  ) {}

  async execute(prompt: string, options: ExecuteOmxOptions = {}): Promise<OmxExecutionResult> {
    const startedAt = Date.now();

    return new Promise<OmxExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let outputTruncated = false;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let exitCode: number | null = null;

      const child = this.spawnFn(this.config.omxCommand, ['exec', prompt], {
        stdio: 'pipe',
        env: process.env,
      });
      child.stdin.end();

      const appendOutput = (chunk: string, target: 'stdout' | 'stderr'): void => {
        const nextValue = `${target === 'stdout' ? stdout : stderr}${chunk}`;
        const trimmed = nextValue.slice(0, this.config.maxOutputChars);
        if (trimmed.length < nextValue.length) {
          outputTruncated = true;
        }

        if (target === 'stdout') {
          stdout = trimmed;
        } else {
          stderr = trimmed;
        }
      };

      const finish = (
        status: TerminalJobStatus,
        overrides: Partial<JobExecutionMetadata> = {},
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        options.signal?.removeEventListener('abort', handleAbort);

        resolve({
          status,
          stdout,
          stderr,
          exitCode,
          execution: {
            command: this.config.omxCommand,
            timeoutMs: this.config.jobTimeoutMs,
            maxOutputChars: this.config.maxOutputChars,
            durationMs: Date.now() - startedAt,
            outputTruncated,
            timedOut,
            ...overrides,
          },
        });
      };

      child.stdout.on('data', (chunk: Buffer | string) => {
        appendOutput(chunk.toString(), 'stdout');
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        appendOutput(chunk.toString(), 'stderr');
      });

      child.once('error', (error: NodeJS.ErrnoException) => {
        stderr = stderr || error.message;
        finish('failed', {
          errorType: 'spawn_error',
        });
      });

      child.once('close', (code) => {
        exitCode = code;
        if (cancelled) {
          finish('cancelled', { errorType: 'cancelled' });
          return;
        }
        if (timedOut) {
          finish('failed', { errorType: 'timeout' });
          return;
        }

        if (code === 0) {
          finish('succeeded');
          return;
        }

        finish('failed', {
          errorType: 'non_zero_exit',
        });
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        stderr = stderr || `Command timed out after ${this.config.jobTimeoutMs}ms`;
        child.kill('SIGTERM');
      }, this.config.jobTimeoutMs);

      const handleAbort = (): void => {
        cancelled = true;
        stderr = stderr || 'Command cancelled';
        child.kill('SIGTERM');
      };

      if (options.signal) {
        if (options.signal.aborted) {
          handleAbort();
        } else {
          options.signal.addEventListener('abort', handleAbort, { once: true });
        }
      }
    });
  }
}

export const defaultSpawn: SpawnFunction = spawn;
