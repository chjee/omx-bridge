import { Inject, Injectable } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BRIDGE_CONFIG,
  DEFAULT_TMUX_MAX_CAPTURE_BYTES_PER_STREAM,
  DEFAULT_OMX_ENV_ALLOWLIST,
  type BridgeConfig,
} from '../config/bridge-config';
import { CwdBoundaryError, resolveAllowedExecutionCwd } from './cwd-boundary';
import type { BridgeJob, OmxExecutionResult, TmuxSessionState } from './job.types';
import { buildOmxExecArgs } from './omx-exec-args';
import {
  assertPrivateOwnedDirectory,
  ensurePrivateOwnedDirectory,
  JOB_ID_PATTERN,
  PRIVATE_FILE_MODE,
} from './private-state-directory';
import {
  buildTmuxCaptureWrapperScript,
  TMUX_CAPTURE_METADATA_FILE,
  TMUX_CAPTURE_STDERR_TAIL_FILE,
  TMUX_CAPTURE_STDOUT_TAIL_FILE,
  TMUX_CAPTURE_WRAPPER_FILE,
} from './tmux-capture-wrapper';

export type ArtifactCleanupStatus =
  | 'removed'
  | 'not_found'
  | 'retained_live'
  | 'liveness_unknown'
  | 'failed';

export interface ArtifactCleanupResult {
  jobId: string;
  status: ArtifactCleanupStatus;
  detail?: string;
}

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

interface TmuxCaptureMetadata {
  version: 1;
  stdout: TmuxCaptureStreamMetadata;
  stderr: TmuxCaptureStreamMetadata;
  captureFailure: string | null;
  exitCode: number | null;
}

interface TmuxCaptureStreamMetadata {
  bytesSeen: number;
  truncated: boolean;
  tailStart: number;
  tailLength: number;
  finalized: boolean;
}

const PROMPT_FILE = 'prompt.txt';
const STDOUT_FILE = 'stdout.log';
const STDERR_FILE = 'stderr.log';
const EXIT_CODE_FILE = 'exit-code';
const RUNNER_FILE = 'run.sh';
const SESSION_FILE = 'session.json';
const EXIT_CODE_GRACE_MS = 100;
const EXIT_CODE_GRACE_INTERVAL_MS = 10;
const SESSION_FILES = new Set([
  PROMPT_FILE,
  STDOUT_FILE,
  STDERR_FILE,
  EXIT_CODE_FILE,
  RUNNER_FILE,
  SESSION_FILE,
  TMUX_CAPTURE_WRAPPER_FILE,
  TMUX_CAPTURE_METADATA_FILE,
  TMUX_CAPTURE_STDOUT_TAIL_FILE,
  TMUX_CAPTURE_STDERR_TAIL_FILE,
]);

@Injectable()
export class TmuxSessionRunnerService {
  private readyPromise?: Promise<void>;

  constructor(
    @Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig,
    @Inject(TMUX_SPAWN) private readonly spawnFn: TmuxSpawnFunction,
  ) {}

  async start(job: BridgeJob): Promise<TmuxSessionState> {
    const now = new Date().toISOString();
    const sessionDirectory = this.sessionDirectory(job.id);
    await this.ensureReady();
    await this.ensureSessionDirectory(sessionDirectory);
    await Promise.all([
      fs.rm(this.stdoutFile(job.id), { force: true }),
      fs.rm(this.stderrFile(job.id), { force: true }),
      fs.rm(this.exitCodeFile(job.id), { force: true }),
      fs.rm(this.captureWrapperFile(job.id), { force: true }),
      fs.rm(this.captureMetadataFile(job.id), { force: true }),
      fs.rm(this.stdoutTailFile(job.id), { force: true }),
      fs.rm(this.stderrTailFile(job.id), { force: true }),
    ]);

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

    await fs.writeFile(this.sessionFile(job.id), `${JSON.stringify(session, null, 2)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
    });
    await fs.writeFile(this.promptFile(job.id), job.prompt, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
    });
    await fs.writeFile(this.runnerFile(job.id), this.buildRunnerScript(job.id), {
      encoding: 'utf8',
      mode: 0o700,
    });
    await fs.writeFile(this.captureWrapperFile(job.id), buildTmuxCaptureWrapperScript(), {
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
      const capture = await this.readCaptureMetadata(job.id);
      const stdout = await this.readCaptureOutput(this.stdoutFile(job.id), this.stdoutTailFile(job.id), capture?.stdout);
      const stderr = await this.readCaptureOutput(this.stderrFile(job.id), this.stderrTailFile(job.id), capture?.stderr);
      const captureFailed = Boolean(capture?.captureFailure) ||
        Boolean(capture && capture.exitCode !== null && capture.exitCode !== exitCode);
      const outputTruncated = stdout.truncated || stderr.truncated || this.captureWasTruncated(capture);
      const session: TmuxSessionState = {
        ...job.session,
        status: exitCode === 0 && !captureFailed ? 'exited' : 'failed',
        updatedAt: new Date().toISOString(),
        lastExitCode: exitCode,
      };
      await this.writeSessionState(job.id, session);
      return {
        session,
        result: {
          status: exitCode === 0 && !captureFailed ? 'succeeded' : 'failed',
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode,
          execution: {
            command: this.config.tmuxCommand,
            timeoutMs: this.config.jobTimeoutMs,
            maxOutputChars: this.config.maxOutputChars,
            durationMs: this.durationMs(job),
            outputTruncated,
            ...(captureFailed
              ? { errorType: 'execution_error' as const }
              : exitCode === 0 ? {} : { errorType: 'non_zero_exit' as const }),
          },
        },
      };
    }

    if (this.isTimedOut(job)) {
      await this.runTmux(['kill-session', '-t', job.session.sessionName]);
      const capture = await this.readCaptureMetadata(job.id);
      const stdout = await this.readCaptureOutput(this.stdoutFile(job.id), this.stdoutTailFile(job.id), capture?.stdout);
      const stderr = await this.readCaptureOutput(this.stderrFile(job.id), this.stderrTailFile(job.id), capture?.stderr);
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
            outputTruncated: stdout.truncated || stderr.truncated || this.captureWasTruncated(capture),
            errorType: 'timeout',
          },
        },
      };
    }

    if (await this.hasSession(job.session.sessionName)) {
      return null;
    }

    const lateExitCode = await this.waitForExitCode(job.id);
    if (lateExitCode !== undefined) {
      return this.collect(job);
    }

    const capture = await this.readCaptureMetadata(job.id);
    const stdout = await this.readCaptureOutput(this.stdoutFile(job.id), this.stdoutTailFile(job.id), capture?.stdout);
    const stderr = await this.readCaptureOutput(this.stderrFile(job.id), this.stderrTailFile(job.id), capture?.stderr);
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
          outputTruncated: stdout.truncated || stderr.truncated || this.captureWasTruncated(capture),
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

  async removeArtifacts(jobId: string, expectedSessionName: string): Promise<ArtifactCleanupResult> {
    if (!JOB_ID_PATTERN.test(jobId)) return { jobId, status: 'failed', detail: 'invalid_job_id' };
    const canonicalSessionName = this.buildSessionName(jobId);
    if (expectedSessionName !== canonicalSessionName) {
      return { jobId, status: 'liveness_unknown', detail: 'non_canonical_session' };
    }
    const directory = this.sessionDirectory(jobId);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(directory);
    } catch (error) {
      if (this.isMissingFile(error)) return { jobId, status: 'not_found' };
      return { jobId, status: 'failed', detail: this.describeError(error) };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { jobId, status: 'failed', detail: 'unsafe_artifact_path' };
    }
    try {
      await assertPrivateOwnedDirectory(
        directory,
        'Bridge tmux cleanup directory',
        (entry) => entry.isFile() && SESSION_FILES.has(entry.name),
      );
    } catch (error) {
      return { jobId, status: 'failed', detail: this.describeError(error) };
    }

    const sessionName = await this.readPersistedSessionName(jobId);
    if (!sessionName || sessionName !== canonicalSessionName) {
      return { jobId, status: 'liveness_unknown', detail: 'unreadable_session' };
    }
    const liveness = await this.runTmux(['has-session', '-t', expectedSessionName]);
    if (liveness.code === 0) return { jobId, status: 'retained_live' };
    if (!this.isConfirmedMissingSession(liveness)) {
      return { jobId, status: 'liveness_unknown', detail: liveness.stderr || 'tmux_unavailable' };
    }
    try {
      await assertPrivateOwnedDirectory(
        directory,
        'Bridge tmux cleanup directory',
        (entry) => entry.isFile() && SESSION_FILES.has(entry.name),
      );
      const finalStat = await fs.lstat(directory);
      if (finalStat.dev !== stat.dev || finalStat.ino !== stat.ino) {
        return { jobId, status: 'failed', detail: 'artifact_identity_changed' };
      }
      await fs.rm(directory, { recursive: true });
      return { jobId, status: 'removed' };
    } catch (error) {
      return { jobId, status: 'failed', detail: this.describeError(error) };
    }
  }

  async cleanupStaleOrphans(
    jobs: readonly BridgeJob[],
    retentionDays: number,
    durableJobIds: readonly string[] = [],
  ): Promise<ArtifactCleanupResult[]> {
    await this.ensureReady();
    const knownIds = new Set([...jobs.map((job) => job.id), ...durableJobIds]);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const entries = await fs.readdir(this.config.tmuxSessionsDirectory, { withFileTypes: true });
    const results: ArtifactCleanupResult[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB_ID_PATTERN.test(entry.name)) continue;
      if (knownIds.has(entry.name)) continue;
      const directory = this.sessionDirectory(entry.name);
      let newest: number;
      try {
        newest = await this.newestArtifactTimestamp(directory);
      } catch (error) {
        results.push({ jobId: entry.name, status: 'failed', detail: this.describeError(error) });
        continue;
      }
      if (newest >= cutoff) continue;
      const sessionName = await this.readPersistedSessionName(entry.name);
      const canonicalSessionName = this.buildSessionName(entry.name);
      if (!sessionName || sessionName !== canonicalSessionName) {
        results.push({ jobId: entry.name, status: 'liveness_unknown', detail: 'unreadable_session' });
        continue;
      }
      results.push(await this.removeArtifacts(entry.name, canonicalSessionName));
    }
    return results;
  }

  private buildRunnerScript(jobId: string): string {
    const omxCommand = [
      this.shellQuote(this.config.omxCommand),
      ...buildOmxExecArgs(this.config).map((arg) => this.shellQuote(arg)),
    ].join(' ');

    const captureCommand = [
      this.shellQuote(process.execPath),
      this.shellQuote(this.captureWrapperFile(jobId)),
      '--cap',
      String(this.config.tmuxMaxCaptureBytesPerStream ?? DEFAULT_TMUX_MAX_CAPTURE_BYTES_PER_STREAM),
      '--sigkill-grace-ms',
      String(this.config.sigkillGraceMs),
      '--stdout',
      this.shellQuote(this.stdoutFile(jobId)),
      '--stderr',
      this.shellQuote(this.stderrFile(jobId)),
      '--stdout-tail',
      this.shellQuote(this.stdoutTailFile(jobId)),
      '--stderr-tail',
      this.shellQuote(this.stderrTailFile(jobId)),
      '--metadata',
      this.shellQuote(this.captureMetadataFile(jobId)),
      '--exit-code',
      this.shellQuote(this.exitCodeFile(jobId)),
      '--',
      omxCommand,
    ].join(' ');

    return [
      '#!/usr/bin/env bash',
      'original_umask="$(umask)"',
      'umask 077',
      'umask "$original_umask"',
      `exec ${captureCommand} < ${this.shellQuote(this.promptFile(jobId))}`,
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

  private async waitForExitCode(jobId: string): Promise<number | undefined> {
    const deadline = Date.now() + EXIT_CODE_GRACE_MS;

    while (Date.now() <= deadline) {
      const exitCode = await this.readExitCode(jobId);
      if (exitCode !== undefined) {
        return exitCode;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.sleep(Math.min(EXIT_CODE_GRACE_INTERVAL_MS, remainingMs));
    }

    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async readCapturedFile(filePath: string): Promise<CapturedFile> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(filePath, 'r');
      const stat = await handle.stat();
      const limit = this.config.maxOutputChars;
      if (limit <= 0) {
        return { text: '', truncated: stat.size > 0, length: stat.size };
      }
      if (stat.size <= limit) {
        const buffer = Buffer.alloc(stat.size);
        await handle.read(buffer, 0, stat.size, 0);
        return { text: this.decodeCapturedBuffer(buffer), truncated: false, length: stat.size };
      }
      const marker = '\n...[output truncated]...\n';
      const budget = Math.max(0, limit - marker.length);
      const headLength = Math.ceil(budget / 2);
      const tailLength = Math.floor(budget / 2);
      const headText = await this.readUtf8Slice(handle, 0, headLength + 4, headLength, false);
      const tailText = await this.readUtf8Slice(
        handle,
        Math.max(0, stat.size - tailLength - 4),
        tailLength + 4,
        tailLength,
        true,
      );
      return {
        text: `${headText}${marker}${tailText}`.slice(0, limit),
        truncated: true,
        length: stat.size,
      };
    } catch (error) {
      if (this.isMissingFile(error)) {
        return { text: '', truncated: false, length: 0 };
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readCaptureOutput(
    filePath: string,
    tailPath: string,
    capture: TmuxCaptureStreamMetadata | undefined,
  ): Promise<CapturedFile> {
    const head = await this.readCapturedFile(filePath);
    if (!capture?.truncated || capture.finalized) return head;
    const tail = await this.readCaptureTail(tailPath, capture);
    const marker = '\n...[live output truncated]...\n';
    const combined = `${head.text}${marker}${tail}`;
    return {
      text: this.limitCapturedText(combined),
      truncated: true,
      length: head.length + capture.tailLength,
    };
  }

  private async readCaptureTail(tailPath: string, capture: TmuxCaptureStreamMetadata): Promise<string> {
    if (capture.tailLength === 0) return '';
    try {
      const raw = await fs.readFile(tailPath);
      if (capture.tailStart < 0 || capture.tailLength < 0 || capture.tailStart >= raw.length || capture.tailLength > raw.length) {
        return '';
      }
      const end = capture.tailStart + capture.tailLength;
      const ordered = end <= raw.length
        ? raw.subarray(capture.tailStart, end)
        : Buffer.concat([raw.subarray(capture.tailStart), raw.subarray(0, end - raw.length)]);
      return this.decodeCapturedBuffer(ordered);
    } catch {
      return '';
    }
  }

  private limitCapturedText(value: string): string {
    const limit = this.config.maxOutputChars;
    if (value.length <= limit) return value;
    const marker = '\n...[output truncated]...\n';
    const budget = Math.max(0, limit - marker.length);
    return `${value.slice(0, Math.ceil(budget / 2))}${marker}${value.slice(-Math.floor(budget / 2))}`.slice(0, limit);
  }

  private async readCaptureMetadata(jobId: string): Promise<TmuxCaptureMetadata | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.captureMetadataFile(jobId), 'utf8')) as unknown;
      if (!this.isCaptureMetadata(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private decodeCapturedBuffer(buffer: Buffer): string {
    return buffer
      .toString('utf8')
      .replace(/^\uFFFD+/, '')
      .replace(/\uFFFD+(?=\n\.\.\.\[live output truncated\]\.\.\.\n)/g, '')
      .replace(/(\n\.\.\.\[live output truncated\]\.\.\.\n)\uFFFD+/g, '$1')
      .replace(/\uFFFD+$/, '');
  }

  private captureWasTruncated(capture: TmuxCaptureMetadata | null): boolean {
    return capture === null || capture.stdout.truncated || capture.stderr.truncated;
  }

  private isCaptureMetadata(value: unknown): value is TmuxCaptureMetadata {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    const validStream = (stream: unknown): stream is TmuxCaptureMetadata['stdout'] => (
      typeof stream === 'object' && stream !== null &&
      typeof (stream as { bytesSeen?: unknown }).bytesSeen === 'number' &&
      Number.isSafeInteger((stream as { bytesSeen: number }).bytesSeen) &&
      (stream as { bytesSeen: number }).bytesSeen >= 0 &&
      typeof (stream as { truncated?: unknown }).truncated === 'boolean' &&
      typeof (stream as { tailStart?: unknown }).tailStart === 'number' &&
      Number.isSafeInteger((stream as { tailStart: number }).tailStart) &&
      (stream as { tailStart: number }).tailStart >= 0 &&
      typeof (stream as { tailLength?: unknown }).tailLength === 'number' &&
      Number.isSafeInteger((stream as { tailLength: number }).tailLength) &&
      (stream as { tailLength: number }).tailLength >= 0 &&
      typeof (stream as { finalized?: unknown }).finalized === 'boolean'
    );
    return record.version === 1 &&
      validStream(record.stdout) &&
      validStream(record.stderr) &&
      (record.captureFailure === null || typeof record.captureFailure === 'string') &&
      (record.exitCode === null || (
        typeof record.exitCode === 'number' &&
        Number.isSafeInteger(record.exitCode) &&
        record.exitCode >= 0
      ));
  }

  private async readUtf8Slice(
    handle: Awaited<ReturnType<typeof fs.open>>,
    position: number,
    bytesToRead: number,
    maxChars: number,
    takeTail: boolean,
  ): Promise<string> {
    if (bytesToRead <= 0 || maxChars <= 0) return '';
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    const decoded = buffer.subarray(0, bytesRead).toString('utf8')
      .replace(/^\uFFFD+/, '')
      .replace(/\uFFFD+$/, '');
    let sliced = takeTail ? decoded.slice(-maxChars) : decoded.slice(0, maxChars);
    if (takeTail && /[\uDC00-\uDFFF]/.test(sliced[0] ?? '')) sliced = sliced.slice(1);
    if (!takeTail && /[\uD800-\uDBFF]/.test(sliced.at(-1) ?? '')) sliced = sliced.slice(0, -1);
    return sliced;
  }

  private async readPersistedSessionName(jobId: string): Promise<string | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.sessionFile(jobId), 'utf8')) as unknown;
      return typeof parsed === 'object' && parsed !== null &&
        typeof (parsed as { sessionName?: unknown }).sessionName === 'string'
        ? (parsed as { sessionName: string }).sessionName
        : null;
    } catch {
      return null;
    }
  }

  private async newestArtifactTimestamp(directory: string): Promise<number> {
    let newest = (await fs.stat(directory)).mtimeMs;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      newest = Math.max(newest, (await fs.stat(path.join(directory, entry.name))).mtimeMs);
    }
    return newest;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isConfirmedMissingSession(result: TmuxCommandResult): boolean {
    return result.code === 1 && /can't find session|no such (?:fake )?session|no server running/i.test(result.stderr);
  }

  private async writeSessionState(jobId: string, session: TmuxSessionState): Promise<void> {
    await this.ensureReady();
    await this.ensureSessionDirectory(this.sessionDirectory(jobId));
    await fs.writeFile(this.sessionFile(jobId), `${JSON.stringify(session, null, 2)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
    });
  }

  async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.prepareDirectories();
    }
    const ready = this.readyPromise;
    try {
      await ready;
    } catch (error) {
      if (this.readyPromise === ready) this.readyPromise = undefined;
      throw error;
    }
  }

  private async prepareDirectories(): Promise<void> {
    await ensurePrivateOwnedDirectory(
      this.config.tmuxSessionsDirectory,
      'Bridge tmux sessions directory',
      (entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name),
    );
    const entries = await fs.readdir(this.config.tmuxSessionsDirectory, { withFileTypes: true });
    for (const entry of entries.filter((candidate) => (
      candidate.isDirectory() && JOB_ID_PATTERN.test(candidate.name)
    ))) {
      await this.ensureSessionDirectory(path.join(this.config.tmuxSessionsDirectory, entry.name));
    }
  }

  private ensureSessionDirectory(directory: string): Promise<void> {
    return ensurePrivateOwnedDirectory(
      directory,
      'Bridge tmux job directory',
      (entry) => entry.isFile() && SESSION_FILES.has(entry.name),
    );
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

  private captureWrapperFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), TMUX_CAPTURE_WRAPPER_FILE);
  }

  private captureMetadataFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), TMUX_CAPTURE_METADATA_FILE);
  }

  private stdoutTailFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), TMUX_CAPTURE_STDOUT_TAIL_FILE);
  }

  private stderrTailFile(jobId: string): string {
    return path.join(this.sessionDirectory(jobId), TMUX_CAPTURE_STDERR_TAIL_FILE);
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
