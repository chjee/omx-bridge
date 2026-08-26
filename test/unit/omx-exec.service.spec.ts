import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { OmxExecService, type SpawnFunction } from '../../src/jobs/omx-exec.service';
import { JobQueueRepository } from '../../src/jobs/job-queue.repository';
import { JobRunnerService } from '../../src/jobs/job-runner.service';
import type { JobNotifyService } from '../../src/jobs/job-notify.service';
import type { BridgeJob } from '../../src/jobs/job.types';
import { createTempDir, waitFor } from '../helpers';

class MockChildProcess extends EventEmitter {
  pid: number | undefined = 424242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn(() => true);
}

function captureStdin(child: MockChildProcess): () => string {
  const chunks: string[] = [];
  child.stdin.on('data', (chunk: Buffer | string) => {
    chunks.push(chunk.toString());
  });
  return () => chunks.join('');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const ownedTestProcessGroups = new Set<number>();
const ownedTestReadyFiles = new Set<string>();

async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  // A group KILL can leave a short-lived zombie until init reaps it. It is no
  // longer executable and must not be treated as a surviving descendant.
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return !stat.includes(') Z ');
  } catch {
    return true;
  }
}

function processTreeSpawn(ignoreTerm: boolean, ready: ReturnType<typeof deferred<{ parent: number; descendant: number }>>): SpawnFunction {
  const readyFile = path.join(os.tmpdir(), `omx-exec-tree-${randomUUID()}.pids`);
  ownedTestReadyFiles.add(readyFile);
  const descendant = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, process.ppid + ':' + process.pid, { mode: 0o600 });`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const parentTermHandler = ignoreTerm ? `process.on('SIGTERM', () => {});` : '';
  const parent = [
    "const { spawn } = require('node:child_process');",
    parentTermHandler,
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
    'setInterval(() => {}, 1000);',
  ].join('');
  return (_command, _args, options) => {
    const child = spawn(process.execPath, ['-e', parent], options) as ChildProcessWithoutNullStreams;
    if (child.pid) ownedTestProcessGroups.add(child.pid);
    void (async () => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          const [parentPid, descendantPid] = (await fs.readFile(readyFile, 'utf8'))
            .trim()
            .split(':')
            .map(Number);
          await fs.rm(readyFile, { force: true });
          ownedTestReadyFiles.delete(readyFile);
          if (!Number.isInteger(parentPid) || !Number.isInteger(descendantPid)) {
            ready.reject(new Error(`invalid process-tree readiness evidence: ${parentPid}:${descendantPid}`));
            return;
          }
          if (parentPid !== child.pid) {
            ready.reject(new Error(`process-tree parent mismatch: expected ${child.pid}, got ${parentPid}`));
            return;
          }
          ready.resolve({ parent: parentPid, descendant: descendantPid });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            ready.reject(error);
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      ready.reject(new Error(`process-tree readiness file was not created: ${readyFile}`));
    })();
    return child;
  };
}

async function cleanupOwnedTestGroups(): Promise<void> {
  const groups = [...ownedTestProcessGroups];
  ownedTestProcessGroups.clear();
  for (const group of groups) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  await Promise.all([...ownedTestReadyFiles].map((file) => fs.rm(file, { force: true })));
  ownedTestReadyFiles.clear();
  if (groups.length > 0) await new Promise((resolve) => setTimeout(resolve, 25));
}

function createService(
  spawnFn: SpawnFunction,
  overrides: Partial<BridgeConfig> = {},
): OmxExecService {
  const config: BridgeConfig = {
    host: '127.0.0.1',
    jobsDirectory: '/tmp/jobs',
    omxCommand: 'omx',
    tmuxCommand: 'tmux',
    tmuxSessionsDirectory: '/tmp/sessions',
    jobPollIntervalMs: 10,
    jobTimeoutMs: 100,
    maxOutputChars: 10,
    sigkillGraceMs: 50,
    maxConcurrency: 1,
    maxActiveJobs: 50,
    jobRetentionDays: 7,
    maxTerminalJobs: 1000,
    jobCleanupIntervalMs: 3600000,
    notifyTimeoutMs: 5000,
    notifyMode: 'openclaw',
    insecureLoopback: false,
    allowedCwdPrefixes: ['/workspace'],
    ...overrides,
  };

  return new OmxExecService(config, spawnFn);
}

describe('OmxExecService', () => {
  const originalEnv = process.env;

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await cleanupOwnedTestGroups();
    process.env = originalEnv;
  });

  it('invokes omx exec and maps a successful result', async () => {
    const child = new MockChildProcess();
    const spawnFn = jest.fn(
      () => child as unknown as ChildProcessWithoutNullStreams,
    );
    const service = createService(spawnFn, { maxOutputChars: 100 });
    const readStdin = captureStdin(child);

    const pending = service.execute('hello world');
    child.stdout.write('ok');
    child.stderr.write('warn');
    child.emit('close', 0);

    const result = await pending;

    expect(spawnFn).toHaveBeenCalledWith(
      'omx',
      ['exec', '--full-auto', '-s', 'danger-full-access', '-'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(readStdin()).toBe('hello world');
    expect(child.stdin.writableEnded).toBe(true);
    expect(result).toMatchObject({
      status: 'succeeded',
      stdout: 'ok',
      stderr: 'warn',
      exitCode: 0,
      execution: {
        command: 'omx',
      },
    });
  });

  it('maps non-zero exit codes into failed results', async () => {
    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
    );

    const pending = service.execute('fail me');
    child.stderr.write('boom');
    child.emit('close', 2);

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      stderr: 'boom',
      exitCode: 2,
      execution: { errorType: 'non_zero_exit' },
    });
  });

  it('fails when prompt stdin delivery errors even if the child exits cleanly', async () => {
    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
      { maxOutputChars: 100 },
    );

    const pending = service.execute('lost prompt');
    child.stdin.emit('error', Object.assign(new Error('stdin EPIPE'), { code: 'EPIPE' }));
    child.emit('close', 0);

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      stderr: 'stdin EPIPE',
      exitCode: 0,
      execution: { errorType: 'execution_error' },
    });
  });

  it('passes only allowlisted environment variables to omx exec', async () => {
    process.env = {
      PATH: '/usr/bin',
      HOME: '/home/tester',
      OPENAI_API_KEY: 'model-key',
      BRIDGE_API_TOKEN: 'bridge-token',
      BRIDGE_CALLBACK_SECRET: 'callback-secret',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      CUSTOM_ALLOWED: 'custom-value',
    };
    const child = new MockChildProcess();
    const spawnFn = jest.fn(
      () => child as unknown as ChildProcessWithoutNullStreams,
    );
    const service = createService(spawnFn, {
      omxEnvAllowlist: ['PATH', 'HOME', 'OPENAI_API_KEY', 'CUSTOM_ALLOWED'],
      maxOutputChars: 100,
    });
    const readStdin = captureStdin(child);

    const pending = service.execute('check env');
    child.emit('close', 0);
    await pending;

    expect(spawnFn).toHaveBeenCalledWith(
      'omx',
      ['exec', '--full-auto', '-s', 'danger-full-access', '-'],
      expect.objectContaining({
        env: {
          PATH: '/usr/bin',
          HOME: '/home/tester',
          OPENAI_API_KEY: 'model-key',
          CUSTOM_ALLOWED: 'custom-value',
        },
      }),
    );
    expect(readStdin()).toBe('check env');
  });

  it('passes configured Codex model and reasoning effort options to omx exec', async () => {
    const child = new MockChildProcess();
    const spawnFn = jest.fn(
      () => child as unknown as ChildProcessWithoutNullStreams,
    );
    const service = createService(spawnFn, {
      omxModel: 'gpt-5.5',
      omxModelReasoningEffort: 'xhigh',
      maxOutputChars: 100,
    });

    const pending = service.execute('use options');
    child.emit('close', 0);
    await pending;

    expect(spawnFn).toHaveBeenCalledWith(
      'omx',
      [
        'exec',
        '--full-auto',
        '-s',
        'danger-full-access',
        '--model',
        'gpt-5.5',
        '-c',
        'model_reasoning_effort="xhigh"',
        '-',
      ],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('passes a realpath-normalized cwd when it is inside an allowed prefix', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omx-cwd-'));
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const child = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const service = createService(spawnFn, {
      allowedCwdPrefixes: [root],
      maxOutputChars: 100,
    });

    await service.execute('with cwd', { cwd: project });

    expect(spawnFn).toHaveBeenCalledWith(
      'omx',
      ['exec', '--full-auto', '-s', 'danger-full-access', '-'],
      expect.objectContaining({ cwd: await fs.realpath(project) }),
    );
  });

  it('fails without spawning when cwd resolves outside allowed prefixes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omx-cwd-'));
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    const link = path.join(allowed, 'link-outside');
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    await fs.symlink(outside, link, 'dir');
    const spawnFn = jest.fn();
    const service = createService(spawnFn as unknown as SpawnFunction, {
      allowedCwdPrefixes: [allowed],
    });

    await expect(service.execute('blocked cwd', { cwd: link })).resolves.toMatchObject({
      status: 'failed',
      stderr: `cwd is outside allowed prefixes: ${link}`,
      exitCode: null,
      execution: { errorType: 'invalid_cwd' },
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('maps spawn errors into failed results', async () => {
    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
      { maxOutputChars: 100 },
    );

    const pending = service.execute('missing');
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      stderr: 'spawn ENOENT',
      exitCode: null,
      execution: { errorType: 'spawn_error' },
    });
  });

  it('maps timeout into a failed result', async () => {
    jest.useFakeTimers();
    const processKill = jest.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);

    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
      {
        jobTimeoutMs: 50,
      },
    );

    const pending = service.execute('slow');
    jest.advanceTimersByTime(50);
    child.emit('close', null);

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      exitCode: null,
      execution: { errorType: 'timeout', timedOut: true },
    });
    expect(processKill).toHaveBeenCalledWith(-424242, 'SIGTERM');
  });

  it('keeps head and tail when captured output exceeds the limit', async () => {
    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
      {
        maxOutputChars: 40,
      },
    );

    const pending = service.execute('truncate');
    child.stdout.write('HEAD-1234567890-MIDDLE-abcdefghijklmnopqrstuvwxyz-TAIL');
    child.emit('close', 0);

    const result = await pending;

    expect(result.status).toBe('succeeded');
    expect(result.stdout).toHaveLength(40);
    expect(result.stdout).toContain('...[truncated ');
    expect(result.stdout).toContain(' chars]...');
    expect(result.stdout.startsWith('HEAD')).toBe(true);
    expect(result.stdout.endsWith('TAIL')).toBe(true);
    expect(result.execution.outputTruncated).toBe(true);
  });

  it('keeps the latest output tail across multiple chunks', async () => {
    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
      { maxOutputChars: 80 },
    );

    const pending = service.execute('streaming output');
    child.stderr.write(`BEGIN-${'x'.repeat(60)}-MIDDLE-`);
    child.stderr.write('error: final failure details');
    child.emit('close', 1);

    const result = await pending;

    expect(result.status).toBe('failed');
    expect(result.stderr).toHaveLength(80);
    expect(result.stderr).toContain('...[truncated ');
    expect(result.stderr.startsWith('BEGIN')).toBe(true);
    expect(result.stderr).toContain('failure details');
    expect(result.execution.outputTruncated).toBe(true);
  });

  it('preserves stderr chunks arriving after stdout reaches the limit', async () => {
    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
      { maxOutputChars: 4 },
    );

    const pending = service.execute('heavy stdout');
    child.stdout.write('abcdef'); // fills stdout (4 chars) and sets stdoutTruncated
    child.stderr.write('ERR');   // must still be captured independently
    child.emit('close', 1);

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      stdout: 'cdef',
      stderr: 'ERR',
      execution: { outputTruncated: true },
    });
  });

  it('maps abort signals into cancelled results', async () => {
    const processKill = jest.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
    );
    const controller = new AbortController();

    const pending = service.execute('cancel me', { signal: controller.signal });
    controller.abort();
    child.emit('close', null);

    await expect(pending).resolves.toMatchObject({
      status: 'cancelled',
      exitCode: null,
      execution: { errorType: 'cancelled' },
    });
    expect(processKill).toHaveBeenCalledWith(-424242, 'SIGTERM');
  });

  it('sends one bounded TERM-to-KILL escalation to the owned POSIX group', async () => {
    if (process.platform === 'win32') return;
    jest.useFakeTimers();
    const processKill = jest.spyOn(process, 'kill').mockReturnValue(true);
    const child = new MockChildProcess();
    const service = createService(jest.fn(() => child as unknown as ChildProcessWithoutNullStreams), {
      jobTimeoutMs: 50, sigkillGraceMs: 25,
    });

    const pending = service.execute('slow');
    jest.advanceTimersByTime(75);
    expect(processKill.mock.calls).toEqual([[-424242, 'SIGTERM'], [-424242, 'SIGKILL']]);
    child.emit('close', null);
    await pending;
  });

  it('clears owned-group escalation on close and never signals an invalid pid', async () => {
    if (process.platform === 'win32') return;
    jest.useFakeTimers();
    const processKill = jest.spyOn(process, 'kill').mockReturnValue(true);
    const child = new MockChildProcess();
    child.pid = 0;
    const controller = new AbortController();
    const service = createService(jest.fn(() => child as unknown as ChildProcessWithoutNullStreams));
    const pending = service.execute('cancel', { signal: controller.signal });
    controller.abort();
    child.emit('close', null);
    jest.runAllTimers();
    await pending;
    expect(processKill).not.toHaveBeenCalled();
  });

  it('treats POSIX ESRCH as already clean and exposes other signal failures', async () => {
    if (process.platform === 'win32') return;
    const esrchChild = new MockChildProcess();
    jest.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const esrchController = new AbortController();
    const esrchPending = createService(jest.fn(() => esrchChild as unknown as ChildProcessWithoutNullStreams))
      .execute('cancel', { signal: esrchController.signal });
    esrchController.abort();
    esrchChild.emit('close', null);
    await expect(esrchPending).resolves.toMatchObject({ status: 'cancelled' });

    jest.restoreAllMocks();
    const deniedChild = new MockChildProcess();
    jest.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    const deniedController = new AbortController();
    const deniedPending = createService(
      jest.fn(() => deniedChild as unknown as ChildProcessWithoutNullStreams),
      { maxOutputChars: 100 },
    )
      .execute('cancel', { signal: deniedController.signal });
    deniedController.abort();
    await expect(deniedPending).resolves.toMatchObject({
      status: 'failed', stderr: expect.stringContaining('Failed to signal owned process: denied'),
      execution: { errorType: 'execution_error' },
    });
  });

  describe('POSIX detached process-group cleanup', () => {
    const skipOnWindows = process.platform === 'win32';

    it('removes an actual detached descendant after timeout and bounded TERM-to-KILL escalation', async () => {
      if (skipOnWindows) return;
      const ready = deferred<{ parent: number; descendant: number }>();
      const service = createService(processTreeSpawn(true, ready), { jobTimeoutMs: 1_000, sigkillGraceMs: 50 });
      const result = service.execute('timeout tree');
      const tree = await ready.promise;

      await expect(result).resolves.toMatchObject({ execution: { errorType: 'timeout', timedOut: true } });
      await waitFor(async () => isAlive(tree.descendant), (alive) => !alive, 1_000, 10);
    });

    it('escalates when the group leader exits but a descendant survives SIGTERM', async () => {
      if (skipOnWindows) return;
      const ready = deferred<{ parent: number; descendant: number }>();
      const signals: Array<[number, NodeJS.Signals]> = [];
      const originalKill = process.kill.bind(process);
      const kill = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (typeof signal === 'string') signals.push([pid, signal]);
        return originalKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill);
      const service = createService(processTreeSpawn(false, ready), { jobTimeoutMs: 1_000, sigkillGraceMs: 50 });
      const controller = new AbortController();
      const result = service.execute('abort tree', { signal: controller.signal });
      const tree = await ready.promise;
      controller.abort();

      await expect(result).resolves.toMatchObject({ status: 'cancelled' });
      await waitFor(async () => isAlive(tree.descendant), (alive) => !alive, 1_000, 10);
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(signals).toEqual([[-tree.parent, 'SIGTERM'], [-tree.parent, 'SIGKILL']]);
      kill.mockRestore();
    });

    it('aborts the actual detached process group during runner shutdown', async () => {
      if (skipOnWindows) return;
      const jobsDirectory = await createTempDir('omx-shutdown-tree');
      const config: BridgeConfig = {
        host: '127.0.0.1', jobsDirectory, omxCommand: 'omx', tmuxCommand: 'tmux',
        tmuxSessionsDirectory: `${jobsDirectory}/sessions`, jobPollIntervalMs: 60_000,
        jobTimeoutMs: 1_000, maxOutputChars: 1_000, sigkillGraceMs: 50,
        maxConcurrency: 1, maxActiveJobs: 50, jobRetentionDays: 7, maxTerminalJobs: 1000,
        jobCleanupIntervalMs: 60_000, notifyTimeoutMs: 1_000, notifyMode: 'openclaw',
        insecureLoopback: false, allowedCwdPrefixes: ['/workspace'],
      };
      const ready = deferred<{ parent: number; descendant: number }>();
      const repository = new JobQueueRepository(config);
      await repository.ensureReady();
      const bridgeJob: BridgeJob = {
        id: '00000000-0000-4000-a000-000000000009', prompt: 'shutdown tree',
        queueOrder: '0000000000001-000001', status: 'queued', createdAt: new Date().toISOString(),
        exitCode: null, stdout: '', stderr: '',
        execution: { command: 'omx', timeoutMs: config.jobTimeoutMs, maxOutputChars: config.maxOutputChars },
      };
      await repository.save(bridgeJob);
      const runner = new JobRunnerService(
        repository,
        new OmxExecService(config, processTreeSpawn(false, ready)),
        { notifyJobComplete: jest.fn().mockResolvedValue(undefined) } as unknown as JobNotifyService,
        config,
      );
      const run = runner.runOnce();
      const tree = await ready.promise;
      await runner.onModuleDestroy();
      await run;

      await expect(repository.getById(bridgeJob.id)).resolves.toMatchObject({ status: 'cancelled' });
      await waitFor(async () => isAlive(tree.descendant), (alive) => !alive, 1_000, 10);
    });
  });
});
