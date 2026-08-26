import { Inject, Injectable } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { BRIDGE_CONFIG, DEFAULT_OMX_ENV_ALLOWLIST, type BridgeConfig } from '../config/bridge-config';
import { CwdBoundaryError, resolveAllowedExecutionCwd } from './cwd-boundary';
import type { JobExecutionMetadata, OmxExecutionResult, TerminalJobStatus } from './job.types';
import { buildOmxExecArgs } from './omx-exec-args';

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
    const cwdResolution = options.cwd
      ? await this.resolveExecutionCwd(options.cwd, startedAt)
      : undefined;
    if (cwdResolution && typeof cwdResolution !== 'string') {
      return cwdResolution;
    }
    const executionCwd = cwdResolution;

    return new Promise<OmxExecutionResult>((resolve) => {
      let stdoutCapture = this.emptyOutputCapture();
      let stderrCapture = this.emptyOutputCapture();
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let stdinWriteFailed = false;
      let exitCode: number | null = null;
      let sigkillHandle: NodeJS.Timeout | undefined;
      let groupExitPollHandle: NodeJS.Timeout | undefined;
      let ownedProcessGroupPid: number | undefined;
      let terminationStarted = false;
      let childClosed = false;

      const child = this.spawnFn(
        this.config.omxCommand,
        buildOmxExecArgs(this.config),
        {
          stdio: 'pipe',
          env: this.buildChildEnv(),
          ...(process.platform !== 'win32' ? { detached: true } : {}),
          ...(executionCwd ? { cwd: executionCwd } : {}),
        },
      );
      if (this.isValidPid(child.pid)) {
        ownedProcessGroupPid = child.pid;
      }
      child.stdin.once('error', (error: NodeJS.ErrnoException) => {
        stdinWriteFailed = true;
        if (stderrCapture.length === 0) {
          stderrCapture = this.appendCapturedOutput(stderrCapture, error.message);
        }
      });
      child.stdin.end(prompt);

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
        clearInterval(groupExitPollHandle);
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

      const clearProcessOwnership = (): void => {
        clearTimeout(sigkillHandle);
        clearInterval(groupExitPollHandle);
        sigkillHandle = undefined;
        groupExitPollHandle = undefined;
        ownedProcessGroupPid = undefined;
      };

      const finishTerminated = (): void => {
        if (!childClosed || settled) return;
        clearProcessOwnership();
        if (cancelled) {
          finish('cancelled', { errorType: 'cancelled' });
          return;
        }
        finish('failed', { errorType: 'timeout' });
      };

      const isOwnedProcessGroupAlive = (): boolean => {
        if (process.platform === 'win32' || ownedProcessGroupPid === undefined) return false;
        try {
          process.kill(-ownedProcessGroupPid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
        }
      };

      const waitForOwnedProcessGroupExit = (): void => {
        if (groupExitPollHandle || settled) return;
        const observe = (): void => {
          if (!isOwnedProcessGroupAlive()) finishTerminated();
        };
        groupExitPollHandle = setInterval(observe, 10);
        observe();
      };

      child.stdout.on('data', (chunk: Buffer | string) => {
        appendOutput(chunk.toString(), 'stdout');
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        appendOutput(chunk.toString(), 'stderr');
      });

      child.once('error', (error: NodeJS.ErrnoException) => {
        clearProcessOwnership();
        if (stderrCapture.length === 0) {
          stderrCapture = this.appendCapturedOutput(stderrCapture, error.message);
        }
        finish('failed', {
          errorType: 'spawn_error',
        });
      });

      child.once('close', (code) => {
        childClosed = true;
        exitCode = code;
        if (cancelled || timedOut) {
          if (terminationStarted && isOwnedProcessGroupAlive()) {
            waitForOwnedProcessGroupExit();
          } else {
            finishTerminated();
          }
          return;
        }
        clearProcessOwnership();
        if (stdinWriteFailed) {
          finish('failed', { errorType: 'execution_error' });
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

      const signalOwnedProcess = (signal: NodeJS.Signals): boolean => {
        try {
          if (process.platform === 'win32') {
            // Windows can terminate only the direct child here; descendant cleanup is not guaranteed.
            if (ownedProcessGroupPid === undefined) return false;
            child.kill(signal);
          } else if (ownedProcessGroupPid !== undefined) {
            process.kill(-ownedProcessGroupPid, signal);
          } else {
            return false;
          }
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') {
            clearProcessOwnership();
            return false;
          }
          stderrCapture = this.appendCapturedOutput(
            stderrCapture,
            `Failed to signal owned process: ${error instanceof Error ? error.message : String(error)}`,
          );
          clearProcessOwnership();
          finish('failed', { errorType: 'execution_error' });
          return false;
        }
      };

      const sendSigkillAfterDelay = (): void => {
        sigkillHandle = setTimeout(() => {
          sigkillHandle = undefined;
          signalOwnedProcess('SIGKILL');
          clearProcessOwnership();
          finishTerminated();
        }, this.config.sigkillGraceMs);
      };

      const terminate = (): void => {
        if (terminationStarted || settled) return;
        terminationStarted = true;
        if (signalOwnedProcess('SIGTERM')) sendSigkillAfterDelay();
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (stderrCapture.length === 0) {
          stderrCapture = this.appendCapturedOutput(
            stderrCapture,
            `Command timed out after ${this.config.jobTimeoutMs}ms`,
          );
        }
        terminate();
      }, this.config.jobTimeoutMs);

      const handleAbort = (): void => {
        cancelled = true;
        if (stderrCapture.length === 0) {
          stderrCapture = this.appendCapturedOutput(stderrCapture, 'Command cancelled');
        }
        terminate();
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

  private isValidPid(pid: number | undefined): pid is number {
    return typeof pid === 'number' && Number.isFinite(pid) && Number.isInteger(pid) && pid > 0;
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

  private async resolveExecutionCwd(
    cwd: string | undefined,
    startedAt: number,
  ): Promise<string | OmxExecutionResult | undefined> {
    try {
      return await resolveAllowedExecutionCwd(cwd, this.config.allowedCwdPrefixes);
    } catch (error) {
      if (!(error instanceof CwdBoundaryError)) {
        throw error;
      }
      return {
        status: 'failed',
        stdout: '',
        stderr: error.message,
        exitCode: null,
        execution: {
          command: this.config.omxCommand,
          timeoutMs: this.config.jobTimeoutMs,
          maxOutputChars: this.config.maxOutputChars,
          durationMs: Date.now() - startedAt,
          errorType: 'invalid_cwd',
        },
      };
    }
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
