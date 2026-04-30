import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { OmxExecService, type SpawnFunction } from '../../src/jobs/omx-exec.service';

class MockChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn(() => true);
}

function createService(
  spawnFn: SpawnFunction,
  overrides: Partial<BridgeConfig> = {},
): OmxExecService {
  const config: BridgeConfig = {
    host: '127.0.0.1',
    jobsDirectory: '/tmp/jobs',
    omxCommand: 'omx',
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
    allowedCwdPrefixes: ['/workspace'],
    ...overrides,
  };

  return new OmxExecService(config, spawnFn);
}

describe('OmxExecService', () => {
  const originalEnv = process.env;

  afterEach(() => {
    jest.useRealTimers();
    process.env = originalEnv;
  });

  it('invokes omx exec and maps a successful result', async () => {
    const child = new MockChildProcess();
    const spawnFn = jest.fn(
      () => child as unknown as ChildProcessWithoutNullStreams,
    );
    const service = createService(spawnFn, { maxOutputChars: 100 });

    const pending = service.execute('hello world');
    child.stdout.write('ok');
    child.stderr.write('warn');
    child.emit('close', 0);

    const result = await pending;

    expect(spawnFn).toHaveBeenCalledWith(
      'omx',
      ['exec', '--full-auto', '-s', 'danger-full-access', 'hello world'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
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

    const pending = service.execute('check env');
    child.emit('close', 0);
    await pending;

    expect(spawnFn).toHaveBeenCalledWith(
      'omx',
      ['exec', '--full-auto', '-s', 'danger-full-access', 'check env'],
      expect.objectContaining({
        env: {
          PATH: '/usr/bin',
          HOME: '/home/tester',
          OPENAI_API_KEY: 'model-key',
          CUSTOM_ALLOWED: 'custom-value',
        },
      }),
    );
  });

  it('maps spawn errors into failed results', async () => {
    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
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
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('truncates captured output when it exceeds the limit', async () => {
    const child = new MockChildProcess();
    const service = createService(
      jest.fn(() => child as unknown as ChildProcessWithoutNullStreams),
      {
        maxOutputChars: 4,
      },
    );

    const pending = service.execute('truncate');
    child.stdout.write('abcdef');
    child.emit('close', 0);

    await expect(pending).resolves.toMatchObject({
      status: 'succeeded',
      stdout: 'abcd',
      execution: { outputTruncated: true },
    });
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
      stdout: 'abcd',
      stderr: 'ERR',
      execution: { outputTruncated: true },
    });
  });

  it('maps abort signals into cancelled results', async () => {
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
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
