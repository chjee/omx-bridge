import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
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

async function runShellScript(filePath: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', [filePath], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`script exited with code ${code ?? 'null'}`));
    });
  });
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
    insecureLoopback: false,
    allowedCwdPrefixes: [root],
    ...overrides,
  };
}

describe('TmuxSessionRunnerService', () => {
  it('starts a detached tmux session and writes the session runner files', async () => {
    const config = await createConfig();
    const sessionDirectory = path.join(config.tmuxSessionsDirectory, '00000000-0000-4000-a000-000000000001');
    if (process.platform !== 'win32') {
      await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o755 });
      await fs.chmod(config.tmuxSessionsDirectory, 0o755);
      await fs.chmod(sessionDirectory, 0o755);
    }
    const child = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(config, spawnFn as TmuxSpawnFunction);
    const session = await service.start(createJob());

    expect(spawnFn).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session', '-d', '-s', session.sessionName]),
      expect.objectContaining({ stdio: 'pipe' }),
    );
    await expect(fs.readFile(path.join(sessionDirectory, 'prompt.txt'), 'utf8')).resolves.toBe('hello from tmux');
    const runnerScript = await fs.readFile(path.join(sessionDirectory, 'run.sh'), 'utf8');
    expect(runnerScript).toContain(
      "'omx' 'exec' '--full-auto' '-s' 'danger-full-access' '-'",
    );
    expect(runnerScript.split('\n').slice(0, 3)).toEqual([
      '#!/usr/bin/env bash',
      'original_umask="$(umask)"',
      'umask 077',
    ]);
    expect(runnerScript).toContain('umask "$original_umask"\nset +e');
    await expect(fs.readFile(path.join(sessionDirectory, 'session.json'), 'utf8')).resolves.toContain(session.sessionName);
    if (process.platform !== 'win32') {
      const sessionRootStat = await fs.stat(config.tmuxSessionsDirectory);
      const sessionDirectoryStat = await fs.stat(sessionDirectory);
      const promptStat = await fs.stat(path.join(sessionDirectory, 'prompt.txt'));
      const runnerStat = await fs.stat(path.join(sessionDirectory, 'run.sh'));
      const sessionStat = await fs.stat(path.join(sessionDirectory, 'session.json'));
      expect(sessionRootStat.mode & 0o777).toBe(0o700);
      expect(sessionDirectoryStat.mode & 0o777).toBe(0o700);
      expect(promptStat.mode & 0o777).toBe(0o600);
      expect(runnerStat.mode & 0o777).toBe(0o700);
      expect(sessionStat.mode & 0o777).toBe(0o600);
    }
    expect(session).toMatchObject({
      backend: 'tmux',
      status: 'running',
      attachCommand: `tmux attach -t ${session.sessionName}`,
    });
  });

  it('writes configured Codex model and reasoning effort options into the session runner', async () => {
    const config = await createConfig({
      omxModel: 'gpt-5.5',
      omxModelReasoningEffort: 'high',
    });
    const child = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(config, spawnFn as TmuxSpawnFunction);

    await service.start(createJob());
    const sessionDirectory = path.join(config.tmuxSessionsDirectory, '00000000-0000-4000-a000-000000000001');

    await expect(fs.readFile(path.join(sessionDirectory, 'run.sh'), 'utf8')).resolves.toContain(
      "'omx' 'exec' '--full-auto' '-s' 'danger-full-access' '--model' 'gpt-5.5' '-c' 'model_reasoning_effort=\"high\"' '-'",
    );
  });

  it('keeps shell metacharacters in the configured Codex model as one tmux runner argv', async () => {
    const config = await createConfig();
    const root = path.dirname(config.tmuxSessionsDirectory);
    const argvFile = path.join(root, 'argv.txt');
    const injectedFile = path.join(root, 'injected');
    const substitutionFile = path.join(root, 'substitution');
    const fakeOmxCommand = path.join(root, 'fake-omx.sh');
    const model = `gpt custom'; touch ${injectedFile}; $(touch ${substitutionFile})`;
    await fs.writeFile(
      fakeOmxCommand,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$@" > "$ARGV_FILE"',
        'cat > /dev/null',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o700 },
    );
    const child = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(
      { ...config, omxCommand: fakeOmxCommand, omxModel: model },
      spawnFn as TmuxSpawnFunction,
    );

    await service.start(createJob());
    const runFile = path.join(config.tmuxSessionsDirectory, '00000000-0000-4000-a000-000000000001', 'run.sh');
    await runShellScript(runFile, { ARGV_FILE: argvFile });

    const argv = await fs.readFile(argvFile, 'utf8');
    expect(argv.split('\n')).toEqual([
      'exec',
      '--full-auto',
      '-s',
      'danger-full-access',
      '--model',
      model,
      '-',
      '',
    ]);
    await expect(fs.access(injectedFile)).rejects.toThrow();
    await expect(fs.access(substitutionFile)).rejects.toThrow();
  });

  it('creates redirected tmux output and exit files with private modes', async () => {
    if (process.platform === 'win32') return;
    const config = await createConfig();
    const root = path.dirname(config.tmuxSessionsDirectory);
    const fakeOmxCommand = path.join(root, 'private-output-omx.sh');
    const inheritedUmaskFile = path.join(root, 'child-umask.txt');
    const workspaceFile = path.join(root, 'workspace-file.txt');
    await fs.writeFile(
      fakeOmxCommand,
      [
        '#!/usr/bin/env bash',
        'cat > /dev/null',
        'umask > "$UMASK_FILE"',
        ': > "$WORKSPACE_FILE"',
        "printf 'stdout-data'",
        "printf 'stderr-data' >&2",
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o700 },
    );
    const child = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(
      { ...config, omxCommand: fakeOmxCommand },
      spawnFn as TmuxSpawnFunction,
    );
    const job = createJob();

    await service.start(job);
    const sessionDirectory = path.join(config.tmuxSessionsDirectory, job.id);
    await runShellScript(path.join(sessionDirectory, 'run.sh'), {
      UMASK_FILE: inheritedUmaskFile,
      WORKSPACE_FILE: workspaceFile,
    });

    await expect(fs.readFile(path.join(sessionDirectory, 'stdout.log'), 'utf8')).resolves.toBe('stdout-data');
    await expect(fs.readFile(path.join(sessionDirectory, 'stderr.log'), 'utf8')).resolves.toBe('stderr-data');
    await expect(fs.readFile(path.join(sessionDirectory, 'exit-code'), 'utf8')).resolves.toBe('0\n');
    for (const fileName of ['stdout.log', 'stderr.log', 'exit-code']) {
      const stat = await fs.stat(path.join(sessionDirectory, fileName));
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const inheritedMask = process.umask();
    const workspaceStat = await fs.stat(workspaceFile);
    expect((await fs.readFile(inheritedUmaskFile, 'utf8')).trim()).toBe(
      inheritedMask.toString(8).padStart(4, '0'),
    );
    expect(workspaceStat.mode & 0o777).toBe(0o666 & ~inheritedMask);
  });

  it('does not chmod a tmux root with unrelated entries', async () => {
    if (process.platform === 'win32') return;
    const config = await createConfig();
    await fs.mkdir(config.tmuxSessionsDirectory, { recursive: true, mode: 0o755 });
    await fs.chmod(config.tmuxSessionsDirectory, 0o755);
    await fs.writeFile(path.join(config.tmuxSessionsDirectory, 'unrelated.txt'), 'keep', 'utf8');
    const service = new TmuxSessionRunnerService(
      config,
      jest.fn(() => new MockChildProcess() as unknown as ChildProcessWithoutNullStreams) as TmuxSpawnFunction,
    );

    await expect(service.ensureReady()).resolves.toBeUndefined();

    const stat = await fs.stat(config.tmuxSessionsDirectory);
    expect(stat.mode & 0o777).toBe(0o755);
  });

  it('rejects a symlinked tmux ancestor without changing the target mode and can retry', async () => {
    if (process.platform === 'win32') return;
    const config = await createConfig();
    const targetDirectory = await createTempDir('tmux-target');
    const linkedAncestor = path.dirname(config.tmuxSessionsDirectory);
    const linkedRoot = `${linkedAncestor}-link`;
    config.tmuxSessionsDirectory = path.join(linkedRoot, 'sessions');
    await fs.chmod(targetDirectory, 0o755);
    await fs.symlink(targetDirectory, linkedRoot, 'dir');
    const service = new TmuxSessionRunnerService(
      config,
      jest.fn(() => new MockChildProcess() as unknown as ChildProcessWithoutNullStreams) as TmuxSpawnFunction,
    );

    await expect(service.ensureReady()).rejects.toThrow('symbolic link');

    const stat = await fs.stat(targetDirectory);
    expect(stat.mode & 0o777).toBe(0o755);
    await expect(fs.stat(path.join(targetDirectory, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(linkedRoot);
    await fs.mkdir(config.tmuxSessionsDirectory, { recursive: true, mode: 0o700 });
    await expect(service.ensureReady()).resolves.toBeUndefined();
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

  it('collects a late exit code after observing a dead session', async () => {
    const config = await createConfig({ jobTimeoutMs: 60 * 60 * 1000 });
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
    const sessionDirectory = path.join(config.tmuxSessionsDirectory, job.id);
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionDirectory, 'stdout.log'), 'done late', 'utf8');
    await fs.writeFile(path.join(sessionDirectory, 'stderr.log'), '', 'utf8');

    const hasSession = new MockChildProcess();
    const spawnFn = jest.fn(() => {
      setImmediate(() => {
        hasSession.emit('close', 1);
        setTimeout(() => {
          void fs.writeFile(path.join(sessionDirectory, 'exit-code'), '0\n', 'utf8');
        }, 20);
      });
      return hasSession as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(config, spawnFn as TmuxSpawnFunction);

    await expect(service.collect(job)).resolves.toMatchObject({
      session: {
        status: 'exited',
        lastExitCode: 0,
      },
      result: {
        status: 'succeeded',
        stdout: 'done late',
        exitCode: 0,
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

  it('removes inactive artifacts and retains live or unreadable sessions', async () => {
    const config = await createConfig();
    const job = createJob();
    const sessionDirectory = path.join(config.tmuxSessionsDirectory, job.id);
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionDirectory, 'session.json'), JSON.stringify({
      sessionName: 'omx-bridge-cleanup',
    }));
    const inactive = new MockChildProcess();
    const service = new TmuxSessionRunnerService(config, jest.fn(() => {
      setImmediate(() => {
        inactive.stderr.write("can't find session: omx-bridge-cleanup");
        inactive.emit('close', 1);
      });
      return inactive as unknown as ChildProcessWithoutNullStreams;
    }) as TmuxSpawnFunction);

    await expect(service.removeArtifacts(job.id, 'omx-bridge-cleanup')).resolves.toEqual({
      jobId: job.id,
      status: 'removed',
    });
    await expect(service.removeArtifacts(job.id, 'omx-bridge-cleanup')).resolves.toEqual({
      jobId: job.id,
      status: 'not_found',
    });

    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionDirectory, 'session.json'), '{bad-json');
    await expect(service.removeArtifacts(job.id, 'omx-bridge-cleanup')).resolves.toMatchObject({
      status: 'liveness_unknown',
    });
  });

  it('retains artifacts when code one reports a tmux command failure', async () => {
    const config = await createConfig();
    const job = createJob();
    const directory = path.join(config.tmuxSessionsDirectory, job.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'session.json'), JSON.stringify({ sessionName: 'owned-session' }));
    const child = new MockChildProcess();
    const service = new TmuxSessionRunnerService(config, jest.fn(() => {
      setImmediate(() => {
        child.stderr.write('permission denied');
        child.emit('close', 1);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as TmuxSpawnFunction);

    await expect(service.removeArtifacts(job.id, 'owned-session')).resolves.toMatchObject({
      status: 'liveness_unknown',
    });
    await expect(fs.stat(directory)).resolves.toBeDefined();
  });

  it('rejects invalid and non-dedicated artifact paths without deleting them', async () => {
    const config = await createConfig();
    const service = new TmuxSessionRunnerService(
      config,
      jest.fn(() => new MockChildProcess() as unknown as ChildProcessWithoutNullStreams) as TmuxSpawnFunction,
    );
    await expect(service.removeArtifacts('../outside', 'session')).resolves.toMatchObject({ status: 'failed' });
    const id = '00000000-0000-4000-a000-000000000021';
    const directory = path.join(config.tmuxSessionsDirectory, id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'session.json'), JSON.stringify({ sessionName: 'session' }));
    await fs.writeFile(path.join(directory, 'unrelated.txt'), 'keep');

    await expect(service.removeArtifacts(id, 'session')).resolves.toMatchObject({ status: 'failed' });
    await expect(fs.readFile(path.join(directory, 'unrelated.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('collects large output with bounded head and tail reads', async () => {
    const config = await createConfig({ maxOutputChars: 100 });
    const service = new TmuxSessionRunnerService(
      config,
      jest.fn(() => new MockChildProcess() as unknown as ChildProcessWithoutNullStreams) as TmuxSpawnFunction,
    );
    const job = createJob({
      session: {
        backend: 'tmux',
        sessionName: 'omx-bridge-large',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attachCommand: 'tmux attach -t omx-bridge-large',
      },
    });
    const directory = path.join(config.tmuxSessionsDirectory, job.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'stdout.log'), `HEAD${'x'.repeat(10 * 1024 * 1024)}TAIL`);
    await fs.writeFile(path.join(directory, 'stderr.log'), '');
    await fs.writeFile(path.join(directory, 'exit-code'), '0\n');

    const readSpy = jest.spyOn(fs, 'readFile');
    const collected = await service.collect(job);

    expect(collected?.result.stdout.length).toBeLessThanOrEqual(100);
    expect(collected?.result.stdout).toContain('HEAD');
    expect(collected?.result.stdout).toContain('TAIL');
    expect(collected?.result.execution.outputTruncated).toBe(true);
    expect(readSpy).not.toHaveBeenCalledWith(path.join(directory, 'stdout.log'), expect.anything());
  });

  it('does not split UTF-8 surrogate pairs at bounded output edges', async () => {
    const config = await createConfig({ maxOutputChars: 40 });
    const service = new TmuxSessionRunnerService(
      config,
      jest.fn(() => new MockChildProcess() as unknown as ChildProcessWithoutNullStreams) as TmuxSpawnFunction,
    );
    const job = createJob({ session: {
      backend: 'tmux', sessionName: 'unicode', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      attachCommand: 'tmux attach -t unicode',
    } });
    const directory = path.join(config.tmuxSessionsDirectory, job.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'stdout.log'), `HEAD${'😀'.repeat(100)}TAIL`);
    await fs.writeFile(path.join(directory, 'stderr.log'), '');
    await fs.writeFile(path.join(directory, 'exit-code'), '0\n');

    const collected = await service.collect(job);

    expect(collected?.result.stdout).not.toContain('\uFFFD');
    expect(collected?.result.stdout.length).toBeLessThanOrEqual(40);
  });

  it('sweeps only stale inactive orphan directories', async () => {
    const config = await createConfig();
    const ids = [
      '00000000-0000-4000-a000-000000000011',
      '00000000-0000-4000-a000-000000000012',
      '00000000-0000-4000-a000-000000000013',
      '00000000-0000-4000-a000-000000000014',
    ];
    for (const [index, id] of ids.entries()) {
      const directory = path.join(config.tmuxSessionsDirectory, id);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'session.json'), JSON.stringify({
        sessionName: index === 1 ? 'live-session' : `inactive-${index}`,
      }));
      const time = index === 2 ? new Date() : new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await fs.utimes(directory, time, time);
      await fs.utimes(path.join(directory, 'session.json'), time, time);
    }
    const spawnFn = jest.fn((_command, args) => {
      const child = new MockChildProcess();
      setImmediate(() => {
        if (!args?.includes('live-session')) child.stderr.write("can't find session: inactive");
        child.emit('close', args?.includes('live-session') ? 0 : 1);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const service = new TmuxSessionRunnerService(config, spawnFn as TmuxSpawnFunction);

    const results = await service.cleanupStaleOrphans([], 7, [ids[3]]);

    expect(results).toEqual(expect.arrayContaining([
      { jobId: ids[0], status: 'removed' },
      { jobId: ids[1], status: 'retained_live' },
    ]));
    await expect(fs.stat(path.join(config.tmuxSessionsDirectory, ids[0]))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(config.tmuxSessionsDirectory, ids[1]))).resolves.toBeDefined();
    await expect(fs.stat(path.join(config.tmuxSessionsDirectory, ids[2]))).resolves.toBeDefined();
    await expect(fs.stat(path.join(config.tmuxSessionsDirectory, ids[3]))).resolves.toBeDefined();
  });
});
