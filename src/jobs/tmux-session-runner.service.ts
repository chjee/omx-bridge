import { Inject, Injectable } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BRIDGE_CONFIG,
  DEFAULT_OMX_ENV_ALLOWLIST,
  type BridgeConfig,
} from '../config/bridge-config';
import { CwdBoundaryError, resolveAllowedExecutionCwd } from './cwd-boundary';
import type { BridgeJob, OmxExecutionResult, TmuxSessionState } from './job.types';

export type TmuxSpawnFunction = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export const TMUX_SPAWN = Symbol('TMUX_SPAWN');

export interface TmuxCollectResult {
  result: OmxExecutionResult;
  session: TmuxSessionState;
}

interface TmuxCommandResult {
  code: number | null;
  stderr: string;
}

interface CapturedFile {
  text: string;
  truncated: boolean;
  length: number;
}

const PROMPT_FILE = 'prompt.txt';
const STDOUT_FILE = 'stdout.log';
const STDERR_FILE = 'stderr.log';
const EXIT_CODE_FILE = 'exit-code';
const RUNNER_FILE = 'run.sh';
const SESSION_FILE = 'session.json';

@Injectable()
export class TmuxSessionRunnerService {
  constructor(
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
    @Inject(TMUX_SPAWN) private readonly spawnFn: TmuxSpawnFunction,
  ) {}

  async start(job: BridgeJob): Promise<TmuxSessionState> {
    const now = new Date().toISOString();
    const sessionDirectory = this.sessionDirectory(job.id);
    await fs.mkdir(sessionDirectory, { recursive: true });

    const executionCwd = await this.resolveExecutionCwd(job.cwd);
    const sessionName = this.buildSessionName(job.id);
    const session: TmuxSessionState = {
      backend: 'tmux',
      sessionName,
      status: 'starting',
      createdAt: job.startedAt ?? now,
      updatedAt: now,
      attachCommand: `${this.config.tmuxCommand} attach -t ${sessionName}`,
      ...(executionCwd ? { cwd: executionCwd } : {}),
    };

    await fs.writeFile(this.sessionFile(job.id), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await fs.writeFile(this.promptFile(job.id), job.prompt, { encoding: 'utf8', mode: 0o600 });
    await fs.writeFile(this.runnerFile(job.id), this.buildRunnerScript(job.id), {
      encoding: 'utf8',
      mode: 0o700,
    });

    const args = [
      'new-session',
      '-d',
      '-s',
      sessionName,
      ...(executionCwd ? ['-c', executionCwd] : []),
      this.shellQuote(this.runnerFile(job.id)),
    ];
    const started = await this.runTmux(args);
    if (started.code !== 0) {
      throw new Error(started.stderr || `tmux new-session exited with code ${started.code ?? 'null'}`);
    }

    const runningSession: TmuxSessionState = {
      ...session,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    await this.writeSessionState(job.id, runningSession);
    return runningSession;
  }

  async collect(job: BridgeJob): Promise<TmuxCollectResult | null> {
    if (!job.session || job.session.backend !== 'tmux') {
      return null;
    }

    const exitCode = await this.readExitCode(job.id);
    if (exitCode !== undefined) {
      const stdout = await this.readCapturedFile(this.stdoutFile(job.id));
      const stderr = await this.readCapturedFile(this.stderrFile(job.id));
      const session: TmuxSessionState = {
        ...job.session,
        status: exitCode === 0 ? 'exited' : 'failed',
        updatedAt: new Date().toISOString(),
        lastExitCode: exitCode,
      };
      await this.writeSessionState(job.id, session);
      return {
        session,
        result: {
          status: exitCode === 0 ? 'succeeded' : 'failed',
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode,
          execution: {
            command: this.config.tmuxCommand,
            timeoutMs: this.config.jobTimeoutMs,
            maxOutputChars: this.config.maxOutputChars,
            durationMs: this.durationMs(job),
            outputTruncated: stdout.truncated || stderr.truncated,
            ...(exitCode === 0 ? {} : { errorType: 'non_zero_exit' as const }),
          },
        },
      };
    }

    if (this.isTimedOut(job)) {
      await this.runTmux(['kill-session', '-t', job.session.sessionName]);
      const stdout = await this.readCapturedFile(this.stdoutFile(job.id));
      const stderr = await this.readCapturedFile(this.stderrFile(job.id));
      const message = `Command timed out after ${this.config.jobTimeoutMs}ms`;
      const session: TmuxSessionState = {
        ...job.session,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        lastExitCode: null,
      };
      await this.writeSessionState(job.id, session);

      return {
        session,
        result: {
          status: 'failed',
          stdout: stdout.text,
          stderr: stderr.text ? `${stderr.text}\n${message}` : message,
          exitCode: null,
          execution: {
            command: this.config.tmuxCommand,
            timeoutMs: this.config.jobTimeoutMs,
            maxOutputChars: this.config.maxOutputChars,
            durationMs: this.durationMs(job),
            timedOut: true,
            outputTruncated: stdout.truncated || stderr.truncated,
            errorType: 'timeout',
          },
        },
      };
    }

    if (await this.hasSession(job.session.sessionName)) {
      return null;
    }

    const stdout = await this.readCapturedFile(this.stdoutFile(job.id));
    const stderr = await this.readCapturedFile(this.stderrFile(job.id));
    const message = 'tmux session exited before writing an exit code';
    const session: TmuxSessionState = {
      ...job.session,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      lastExitCode: null,
    };
    await this.writeSessionState(job.id, session);

    return {
      session,
      result: {
        status: 'failed',
        stdout: stdout.text,
        stderr: stderr.text ? `${stderr.text}\n${message}` : message,
        exitCode: null,
        execution: {
          command: this.config.tmuxCommand,
          timeoutMs: this.config.jobTimeoutMs,
          maxOutputChars: this.config.maxOutputChars,
          durationMs: this.durationMs(job),
          outputTruncated: stdout.truncated || stderr.truncated,
          errorType: 'execution_error',
        },
      },
    };
  }

  async cancel(job: BridgeJob): Promise<TmuxSessionState | null> {
    if (!job.session || job.session.backend !== 'tmux') {
      return null;
    }

    const killed = await this.runTmux(['kill-session', '-t', job.session.sessionName]);
    if (killed.code !== 0) {
      return null;
    }
    const session: TmuxSessionState = {
      ...job.session,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    };
    await this.writeSessionState(job.id, session);
    return session;
  }

  private buildRunnerScript(jobId: string): string {
    return [
      '#!/usr/bin/env bash',
      'set +e',
      `${this.shellQuote(this.config.omxCommand)} exec --full-auto -s danger-full-access - < ${this.shellQuote(this.promptFile(jobId))} > ${this.shellQuote(this.stdoutFile(jobId))} 2> ${this.shellQuote(this.stderrFile(jobId))}`,
      'code=$?',
      `printf '%s\\n' "$code" > ${this.shellQuote(this.exitCodeFile(jobId))}`,
      'exit "$code"',
      '',
    ].join('\n');
  }

  private async resolveExecutionCwd(cwd: string | undefined): Promise<string | undefined> {
    try {
      return await resolveAllowedExecutionCwd(cwd, this.config.allowedCwdPrefixes);
    } catch (error) {
      if (!(error instanceof CwdBoundaryError)) {
        throw error;
      }
      throw new Error(error.message);
    }
  }

  private async hasSession(sessionName: string): Promise<boolean> {
    const result = await this.runTmux(['has-session', '-t', sessionName]);
    return result.code === 0;
  }

  private runTmux(args: readonly string[]): Promise<TmuxCommandResult> {
    return new Promise((resolve) => {
      let stderr = '';
      const child = this.spawnFn(this.config.tmuxCommand, args, {
        stdio: 'pipe',
        env: this.buildChildEnv(),
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        resolve({ code: null, stderr: error.message });
      });
      child.once('close', (code) => {
        resolve({ code, stderr });
      });
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

  private async readExitCode(jobId: string): Promise<number | undefined> {
    try {
      const raw = await fs.readFile(this.exitCodeFile(jobId), 'utf8');
      const parsed = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch (error) {
      if (this.isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async readCapturedFile(filePath: string): Promise<CapturedFile> {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      const limit = this.config.maxOutputChars;
      if (text.length <= limit) {
        return { text, truncated: false, length: text.length };
      }
      if (limit <= 0) {
        return { text: '', truncated: true, length: text.length };
      }
      return {
        text: text.slice(0, limit),
        truncated: true,
        length: text.length,
      };
    } catch (error) {
      if (this.isMissingFile(error)) {
        return { text: '', truncated: false, length: 0 };
      }
      throw error;
    }
  }

  private async writeSessionState(jobId: string, session: TmuxSessionState): Promise<void> {
    await fs.mkdir(this.sessionDirectory(jobId), { recursive: true });
    await fs.writeFile(this.sessionFile(jobId), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  }

  private durationMs(job: BridgeJob): number {
    const startedAtMs = Date.parse(job.startedAt ?? job.createdAt);
    return Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : 0;
  }

  private isTimedOut(job: BridgeJob): boolean {
    return this.durationMs(job) >= this.config.jobTimeoutMs;
  }

  private buildSessionName(jobId: string): string {
    return `omx-bridge-${jobId.replace(/-/g, '').slice(0, 24)}`;
  }

  private sessionDirectory(jobId: string): string {
    return path.join(this.config.tmuxSessionsDirectory, jobId);
  }

  private promptFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), PROMPT_FILE);
  }

  private stdoutFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), STDOUT_FILE);
  }

  private stderrFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), STDERR_FILE);
  }

  private exitCodeFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), EXIT_CODE_FILE);
  }

  private runnerFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), RUNNER_FILE);
  }

  private sessionFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), SESSION_FILE);
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private isMissingFile(error: unknown): error is NodeJS.ErrnoException {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
  }
}

export const defaultTmuxSpawn: TmuxSpawnFunction = spawn;
