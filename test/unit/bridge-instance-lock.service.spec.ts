import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BridgeConfig } from '../../src/config/bridge-config';
import { BridgeInstanceLockService } from '../../src/jobs/bridge-instance-lock.service';
import { createTempDir } from '../helpers';

function createConfig(jobsDirectory: string): BridgeConfig {
  return {
    host: '127.0.0.1',
    jobsDirectory,
    omxCommand: 'omx',
    tmuxCommand: 'tmux',
    tmuxSessionsDirectory: path.join(jobsDirectory, 'sessions'),
    jobPollIntervalMs: 100,
    jobTimeoutMs: 900_000,
    maxOutputChars: 32_000,
    sigkillGraceMs: 5000,
    maxConcurrency: 1,
    maxActiveJobs: 50,
    jobRetentionDays: 7,
    maxTerminalJobs: 1000,
    jobCleanupIntervalMs: 3600000,
    notifyTimeoutMs: 5000,
    notifyMode: 'claude',
    allowedCwdPrefixes: ['/workspace'],
  };
}

function lockPath(jobsDirectory: string): string {
  return path.join(jobsDirectory, '.omx-bridge-instance.lock');
}

describe('BridgeInstanceLockService', () => {
  it('creates and removes the instance lock', async () => {
    const jobsDirectory = await createTempDir('bridge-lock');
    const service = new BridgeInstanceLockService(createConfig(jobsDirectory));

    await service.acquire();

    const stat = await fs.stat(lockPath(jobsDirectory));
    expect(stat.isFile()).toBe(true);

    await service.release();

    await expect(fs.stat(lockPath(jobsDirectory))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a second live instance for the same jobs directory', async () => {
    const jobsDirectory = await createTempDir('bridge-lock');
    const first = new BridgeInstanceLockService(createConfig(jobsDirectory));
    const second = new BridgeInstanceLockService(createConfig(jobsDirectory));

    await first.acquire();

    await expect(second.acquire()).rejects.toThrow('Another omx-bridge instance is already using');

    await first.release();
  });

  it('recovers a stale lock file', async () => {
    const jobsDirectory = await createTempDir('bridge-lock');
    await fs.mkdir(jobsDirectory, { recursive: true });
    await fs.writeFile(
      lockPath(jobsDirectory),
      `${JSON.stringify({
        token: 'stale',
        pid: -1,
        acquiredAt: '2026-04-30T00:00:00.000Z',
        jobsDirectory,
      })}\n`,
      'utf8',
    );

    const service = new BridgeInstanceLockService(createConfig(jobsDirectory));

    await service.acquire();

    const raw = await fs.readFile(lockPath(jobsDirectory), 'utf8');
    expect(raw).toContain(`"pid":${process.pid}`);

    await service.release();
  });
});
