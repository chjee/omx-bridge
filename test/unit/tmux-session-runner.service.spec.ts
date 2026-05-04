import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BridgeConfig } from '../../src/config/bridge-config';
import type { BridgeJob } from '../../src/jobs/job.types';
import {
  TmuxSessionRunnerService,
  type TmuxSpawnFunction,
} from '../../src/jobs/tmux-session-runner.service';
import { createTempDir } from '../helpers';

class MockChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn(() => true);
}

function createJob(overrides: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: overrides.id ?? '00000000-0000-4000-a000-000000000001',
    prompt: overrides.prompt ?? 'hello from tmux',
    executionMode: overrides.executionMode ?? 'tmux',
    queueOrder: overrides.queueOrder ?? '0000000000001-000001',
    status: overrides.status ?? 'running',
    createdAt: overrides.createdAt ?? '2026-04-02T00:00:00.000Z',
    startedAt: overrides.startedAt ?? '2026-04-02T00:00:01.000Z',
    exitCode: overrides.exitCode ?? null,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    execution: overrides.execution ?? {
      command: 'tmux',
      timeoutMs: 1000,
      maxOutputChars: 1000,
    },
    ...overrides,
  };
}

async function createConfig(overrides: Partial<BridgeConfig> = {}): Promise<BridgeConfig> {
  const root = await createTempDir('tmux-runner');
  return {
    host: '127.0.0.1',
    jobsDirectory: path.join(root, 'jobs'),
    omxCommand: 'omx',
    tmuxCommand: 'tmux',
    tmuxSessionsDirectory: path.join(root, 'sessions'),
    jobPollIntervalMs: 10,
    jobTimeoutMs: 1000,
    maxOutputChars: 1000,
    sigkillGraceMs: 5000,
    maxConcurrency: 1,
    maxActiveJobs: 50,
    jobRetentionDays: 7,
    maxTerminalJobs: 1000,
    jobCleanupIntervalMs: 3600000,
    notifyTimeoutMs: 5000,
    notifyMode: 'openclaw',
    allowedCwdPrefixes: [root],
    ...overrides,
  };
}

describe('TmuxSessionRunnerService', () => {
  it('starts a detached tmux session and writes the session runner files', async () => {
    const config = await createConfig();
    const child = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(config, spawnFn as TmuxSpawnFunction);
    const session = await service.start(createJob());
    const sessionDirectory = path.join(config.tmuxSessionsDirectory, '00000000-0000-4000-a000-000000000001');

    expect(spawnFn).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session', '-d', '-s', session.sessionName]),
      expect.objectContaining({ stdio: 'pipe' }),
    );
    await expect(fs.readFile(path.join(sessionDirectory, 'prompt.txt'), 'utf8')).resolves.toBe('hello from tmux');
    await expect(fs.readFile(path.join(sessionDirectory, 'run.sh'), 'utf8')).resolves.toContain(
      "omx' exec --full-auto -s danger-full-access -",
    );
    await expect(fs.readFile(path.join(sessionDirectory, 'session.json'), 'utf8')).resolves.toContain(session.sessionName);
    expect(session).toMatchObject({
      backend: 'tmux',
      status: 'running',
      attachCommand: `tmux attach -t ${session.sessionName}`,
    });
  });

  it('collects exit code and captured output from a finished session', async () => {
    const config = await createConfig({ maxOutputChars: 100 });
    const service = new TmuxSessionRunnerService(
      config,
      jest.fn(() => new MockChildProcess() as unknown as ChildProcessWithoutNullStreams) as TmuxSpawnFunction,
    );
    const job = createJob({
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-test',
        status: 'running',
        createdAt: '2026-04-02T00:00:01.000Z',
        updatedAt: '2026-04-02T00:00:02.000Z',
        attachCommand: 'tmux attach -t omx-bridge-test',
      },
    });
    const sessionDirectory = path.join(config.tmuxSessionsDirectory, job.id);
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionDirectory, 'stdout.log'), 'done', 'utf8');
    await fs.writeFile(path.join(sessionDirectory, 'stderr.log'), '', 'utf8');
    await fs.writeFile(path.join(sessionDirectory, 'exit-code'), '0\n', 'utf8');

    await expect(service.collect(job)).resolves.toMatchObject({
      session: {
        status: 'exited',
        lastExitCode: 0,
      },
      result: {
        status: 'succeeded',
        stdout: 'done',
        stderr: '',
        exitCode: 0,
        execution: {
          command: 'tmux',
        },
      },
    });
  });

  it('fails a dead session that did not write an exit code', async () => {
    const config = await createConfig({ jobTimeoutMs: 60 * 60 * 1000 });
    const hasSession = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => hasSession.emit('close', 1));
      return hasSession as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(config, spawnFn as TmuxSpawnFunction);
    const job = createJob({
      startedAt: new Date().toISOString(),
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-test',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attachCommand: 'tmux attach -t omx-bridge-test',
      },
    });
    await expect(service.collect(job)).resolves.toMatchObject({
      session: {
        status: 'failed',
        lastExitCode: null,
      },
      result: {
        status: 'failed',
        stderr: 'tmux session exited before writing an exit code',
        exitCode: null,
        execution: { errorType: 'execution_error' },
      },
    });
  });

  it('times out a still-running session and requests tmux kill', async () => {
    const config = await createConfig({ jobTimeoutMs: 10 });
    const killSession = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => killSession.emit('close', 0));
      return killSession as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(config, spawnFn as TmuxSpawnFunction);
    const job = createJob({
      startedAt: new Date(Date.now() - 1000).toISOString(),
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-test',
        status: 'running',
        createdAt: new Date(Date.now() - 1000).toISOString(),
        updatedAt: new Date(Date.now() - 1000).toISOString(),
        attachCommand: 'tmux attach -t omx-bridge-test',
      },
    });

    await expect(service.collect(job)).resolves.toMatchObject({
      session: {
        status: 'failed',
        lastExitCode: null,
      },
      result: {
        status: 'failed',
        stderr: 'Command timed out after 10ms',
        exitCode: null,
        execution: {
          timedOut: true,
          errorType: 'timeout',
        },
      },
    });
    expect(spawnFn).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', 'omx-bridge-test'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('does not mark a session cancelled when tmux kill fails', async () => {
    const config = await createConfig();
    const killSession = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => {
        killSession.stderr.write('kill failed');
        killSession.emit('close', 1);
      });
      return killSession as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(config, spawnFn as TmuxSpawnFunction);
    const job = createJob({
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-test',
        status: 'running',
        createdAt: '2026-04-02T00:00:01.000Z',
        updatedAt: '2026-04-02T00:00:02.000Z',
        attachCommand: 'tmux attach -t omx-bridge-test',
      },
    });

    await expect(service.cancel(job)).resolves.toBeNull();
  });
});
