import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { BRIDGE_CONFIG, type BridgeConfig } from '../config/bridge-config';
import {
  ensurePrivateOwnedDirectory,
  JOB_STATE_FILE_PATTERN,
  PRIVATE_FILE_MODE,
  tightenPrivateOwnedFile,
} from './private-state-directory';

interface LockFilePayload {
  token: string;
  pid: number;
  acquiredAt: string;
  jobsDirectory: string;
}

@Injectable()
export class BridgeInstanceLockService implements OnModuleDestroy {
  private readonly logger = new Logger(BridgeInstanceLockService.name);
  private readonly token = randomUUID();
  private lockHandle?: FileHandle;

  constructor(@Inject(BRIDGE_CONFIG) private readonly config: BridgeConfig) {}

  async acquire(): Promise<void> {
    if (this.lockHandle) {
      return;
    }

    await this.ensureJobsDirectory();
    await this.acquireFreshLock();
  }

  async release(): Promise<void> {
    const handle = this.lockHandle;
    if (!handle) {
      return;
    }
    this.lockHandle = undefined;

    try {
      await handle.close();
    } finally {
      await this.unlinkOwnLock();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.release();
  }

  private async acquireFreshLock(): Promise<void> {
    try {
      this.lockHandle = await fs.open(this.lockPath(), 'wx', PRIVATE_FILE_MODE);
      await this.lockHandle.writeFile(`${JSON.stringify(this.lockPayload())}\n`, 'utf8');
      return;
    } catch (error) {
      if (!this.isFileExists(error)) {
        throw error;
      }
    }

    await tightenPrivateOwnedFile(this.lockPath(), 'Bridge instance lock');
    const existing = await this.readExistingLock();
    if (existing && this.isPidAlive(existing.pid)) {
      throw new Error(
        `Another omx-bridge instance is already using ${this.config.jobsDirectory} (pid ${existing.pid})`,
      );
    }

    this.logger.warn(
      `Removing stale omx-bridge instance lock for ${this.config.jobsDirectory}`,
    );
    await fs.rm(this.lockPath(), { force: true });
    this.lockHandle = await fs.open(this.lockPath(), 'wx', PRIVATE_FILE_MODE);
    await this.lockHandle.writeFile(`${JSON.stringify(this.lockPayload())}\n`, 'utf8');
  }

  private async readExistingLock(): Promise<LockFilePayload | null> {
    try {
      const raw = await fs.readFile(this.lockPath(), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as LockFilePayload).pid === 'number'
      ) {
        return parsed as LockFilePayload;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async unlinkOwnLock(): Promise<void> {
    try {
      const existing = await this.readExistingLock();
      if (existing?.token === this.token) {
        await fs.rm(this.lockPath(), { force: true });
      }
    } catch {
      // Best-effort cleanup; a stale lock can be recovered on next startup.
    }
  }

  private lockPayload(): LockFilePayload {
    return {
      token: this.token,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      jobsDirectory: this.config.jobsDirectory,
    };
  }

  private lockPath(): string {
    return path.join(this.config.jobsDirectory, '.omx-bridge-instance.lock');
  }

  private async ensureJobsDirectory(): Promise<void> {
    const nestedTmuxDirectory = path.dirname(path.resolve(this.config.tmuxSessionsDirectory)) ===
      path.resolve(this.config.jobsDirectory)
      ? path.basename(this.config.tmuxSessionsDirectory)
      : undefined;
    await ensurePrivateOwnedDirectory(
      this.config.jobsDirectory,
      'Bridge jobs directory',
      (entry) => (
        (entry.isFile() && (
          entry.name === '.omx-bridge-instance.lock' ||
          JOB_STATE_FILE_PATTERN.test(entry.name)
        )) ||
        (entry.isDirectory() && (
          entry.name === 'invalid' ||
          entry.name === nestedTmuxDirectory
        ))
      ),
    );
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      );
    }
  }

  private isFileExists(error: unknown): error is NodeJS.ErrnoException {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EEXIST'
    );
  }
}
