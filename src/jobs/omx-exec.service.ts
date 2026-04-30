import { Inject, Injectable } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { BRIDGE_CONFIG, DEFAULT_OMX_ENV_ALLOWLIST, type BridgeConfig } from '../config/bridge-config';
import type { JobExecutionMetadata, OmxExecutionResult, TerminalJobStatus } from './job.types';

export type SpawnFunction = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export const OMX_SPAWN = Symbol('OMX_SPAWN');

export interface ExecuteOmxOptions {
  signal?: AbortSignal;
  cwd?: string;
}

interface OutputCapture {
  head: string;
  tail: string;
  length: number;
  truncated: boolean;
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
      let stdoutCapture = this.emptyOutputCapture();
      let stderrCapture = this.emptyOutputCapture();
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let exitCode: number | null = null;
      let sigkillHandle: NodeJS.Timeout | undefined;

      const child = this.spawnFn(this.config.omxCommand, ['exec', '--full-auto', '-s', 'danger-full-access', prompt], {
        stdio: 'pipe',
        env: this.buildChildEnv(),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      child.stdin.end();

      const appendOutput = (chunk: string, target: 'stdout' | 'stderr'): void => {
        if (target === 'stdout') {
          stdoutCapture = this.appendCapturedOutput(stdoutCapture, chunk);
        } else {
          stderrCapture = this.appendCapturedOutput(stderrCapture, chunk);
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
        clearTimeout(sigkillHandle);
        options.signal?.removeEventListener('abort', handleAbort);

        resolve({
          status,
          stdout: this.renderCapturedOutput(stdoutCapture),
          stderr: this.renderCapturedOutput(stderrCapture),
          exitCode,
          execution: {
            command: this.config.omxCommand,
            timeoutMs: this.config.jobTimeoutMs,
            maxOutputChars: this.config.maxOutputChars,
            durationMs: Date.now() - startedAt,
            outputTruncated: stdoutCapture.truncated || stderrCapture.truncated,
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
        if (stderrCapture.length === 0) {
          stderrCapture = this.appendCapturedOutput(stderrCapture, error.message);
        }
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

      const sendSigkillAfterDelay = (): void => {
        sigkillHandle = setTimeout(() => {
          child.kill('SIGKILL');
        }, this.config.sigkillGraceMs);
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (stderrCapture.length === 0) {
          stderrCapture = this.appendCapturedOutput(
            stderrCapture,
            `Command timed out after ${this.config.jobTimeoutMs}ms`,
          );
        }
        child.kill('SIGTERM');
        sendSigkillAfterDelay();
      }, this.config.jobTimeoutMs);

      const handleAbort = (): void => {
        cancelled = true;
        if (stderrCapture.length === 0) {
          stderrCapture = this.appendCapturedOutput(stderrCapture, 'Command cancelled');
        }
        child.kill('SIGTERM');
        sendSigkillAfterDelay();
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

  private buildChildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const allowlist = this.config.omxEnvAllowlist ?? DEFAULT_OMX_ENV_ALLOWLIST;
    for (const key of allowlist) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return env;
  }

  private emptyOutputCapture(): OutputCapture {
    return {
      head: '',
      tail: '',
      length: 0,
      truncated: false,
    };
  }

  private appendCapturedOutput(current: OutputCapture, chunk: string): OutputCapture {
    if (chunk.length === 0) {
      return current;
    }

    const limit = this.config.maxOutputChars;
    const nextLength = current.length + chunk.length;
    if (limit <= 0) {
      return {
        head: '',
        tail: '',
        length: nextLength,
        truncated: true,
      };
    }

    if (!current.truncated && nextLength <= limit) {
      return {
        head: current.head + chunk,
        tail: '',
        length: nextLength,
        truncated: false,
      };
    }

    const marker = this.buildTruncationMarker(nextLength, limit);
    if (marker.length >= limit) {
      return {
        head: '',
        tail: this.appendTail(current, chunk, limit),
        length: nextLength,
        truncated: true,
      };
    }

    const remaining = limit - marker.length;
    const headLength = Math.ceil(remaining / 2);
    const tailLength = Math.floor(remaining / 2);
    const sourceForHead = current.truncated ? current.head : current.head + chunk;

    return {
      head: sourceForHead.slice(0, headLength),
      tail: this.appendTail(current, chunk, tailLength),
      length: nextLength,
      truncated: true,
    };
  }

  private appendTail(current: OutputCapture, chunk: string, tailLength: number): string {
    if (tailLength <= 0) {
      return '';
    }

    const source = current.truncated ? current.tail + chunk : current.head + chunk;
    return source.slice(-tailLength);
  }

  private renderCapturedOutput(capture: OutputCapture): string {
    if (!capture.truncated) {
      return capture.head;
    }

    const limit = this.config.maxOutputChars;
    if (limit <= 0) {
      return '';
    }

    const marker = this.buildTruncationMarker(capture.length, limit);
    if (marker.length >= limit) {
      return capture.tail.slice(-limit);
    }

    return `${capture.head}${marker}${capture.tail}`;
  }

  private buildTruncationMarker(totalLength: number, limit: number): string {
    let omitted = Math.max(0, totalLength - limit);
    while (true) {
      const marker = `\n...[truncated ${omitted} chars]...\n`;
      const markerAwareOmitted = Math.max(0, totalLength - (limit - marker.length));
      if (markerAwareOmitted === omitted) {
        return marker;
      }
      omitted = markerAwareOmitted;
    }
  }
}

export const defaultSpawn: SpawnFunction = spawn;
