import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface NotificationStoreJob {
  id: string;
  status: string;
  finishedAt?: string;
  stdout: string;
  stderr: string;
}

export interface JobNotification<TJob extends NotificationStoreJob = NotificationStoreJob> {
  receivedAt: string;
  job: TJob;
}

interface PersistedNotificationRead<TJob extends NotificationStoreJob> {
  notifications: Array<JobNotification<TJob>>;
  malformed: number;
  readFailed: boolean;
}

export interface NotificationStats<TStatus extends string = string> {
  pending: number;
  dropped: number;
  storePath: string;
  storeBytes: number;
  oldestEnqueuedAt: string | null;
  preview?: Array<{
    jobId: string;
    status: TStatus;
    receivedAt: string;
    finishedAt?: string;
    stdoutPreview: string;
    stderrPreview: string;
  }>;
}

export interface NotificationStoreOptions<TJob extends NotificationStoreJob> {
  storePath: string;
  maxQueueSize: number;
  lockStaleMs: number;
  lockTimeoutMs: number;
  previewMax: number;
  previewTextMax: number;
  normalizeNotification: (payload: unknown) => JobNotification<TJob> | null;
  logWarning?: (message: string) => void;
}

export class NotificationStore<TJob extends NotificationStoreJob> {
  private readonly queue: Array<JobNotification<TJob>> = [];
  private readonly lockPath: string;
  private dropped = 0;
  private mutex: Promise<void> = Promise.resolve();

  constructor(private readonly options: NotificationStoreOptions<TJob>) {
    this.lockPath = `${options.storePath}.lock`;
  }

  async load(): Promise<void> {
    await this.withStoreLock(async () => this.withFileLock(async () => {
      const { notifications, malformed, readFailed } = await this.readUnsafe();
      if (readFailed) return;
      const deduped = this.dedupe(notifications);
      const { retained, overflow } = this.retainWithinLimit(deduped);
      this.queue.splice(0, this.queue.length, ...retained);
      this.dropped += overflow;

      if (malformed > 0) {
        this.warn(`skipped ${malformed} malformed persisted notification entr${malformed === 1 ? "y" : "ies"}`);
      }
      if (overflow > 0) {
        this.warn(
          `persisted notification queue overflow on startup: dropped ${overflow} oldest entr${overflow === 1 ? "y" : "ies"} (MAX_NOTIFICATION_QUEUE_SIZE=${this.options.maxQueueSize})`,
        );
      }
      if (retained.length !== notifications.length || malformed > 0 || overflow > 0) {
        try {
          await this.rewriteUnsafe(retained);
        } catch (error) {
          this.warn(`failed to compact persisted notifications: ${describeError(error)}`);
        }
      }
    }));
  }

  async enqueue(notification: JobNotification<TJob>): Promise<number> {
    return this.withStoreLock(async () => this.withFileLock(async () => {
      this.queue.push(notification);

      try {
        const persisted = await this.readUnsafe();
        if (persisted.readFailed) {
          throw new Error("Failed to read persisted notifications before enqueue");
        }
        const deduped = this.dedupe([...persisted.notifications, notification]);
        const { retained, overflow } = this.retainWithinLimit(deduped);
        this.dropped += overflow;

        if (persisted.malformed > 0) {
          this.warn(
            `skipped ${persisted.malformed} malformed persisted notification entr${persisted.malformed === 1 ? "y" : "ies"} while enqueueing`,
          );
        }

        const retainedJobIds = new Set(retained.map((item) => item.job.id));
        const localRetained = this.dedupe(this.queue)
          .filter((item) => retainedJobIds.has(item.job.id));
        this.queue.splice(0, this.queue.length, ...localRetained);

        await this.rewriteUnsafe(retained);
        if (overflow > 0) {
          this.warn(
            `notification queue overflow: dropped ${overflow} oldest entr${overflow === 1 ? "y" : "ies"} (total dropped: ${this.dropped}, MAX_NOTIFICATION_QUEUE_SIZE=${this.options.maxQueueSize}). Call omx_get_notifications more frequently or raise the limit.`,
          );
        }
        return retained.length;
      } catch (error) {
        this.queue.pop();
        this.warn(`failed to persist notification ${notification.job.id}: ${describeError(error)}`);
        await this.appendUnsafe(notification).catch(() => undefined);
        return this.queue.length;
      }
    }));
  }

  async getStats(previewCount = 0): Promise<NotificationStats<TJob["status"]>> {
    return this.withStoreLock(async () => this.withFileLock(async () => {
      const read = await this.readUnsafe();
      if (read.readFailed) {
        const storeBytes = await this.storeBytes();
        return this.buildStats(this.dedupe(this.queue), storeBytes, previewCount);
      }

      const { notifications, malformed } = read;
      const deduped = this.dedupe(notifications);
      if (malformed > 0) {
        this.warn(`skipped ${malformed} malformed persisted notification entr${malformed === 1 ? "y" : "ies"} while reading stats`);
      }
      const storeBytes = await this.storeBytes();
      return this.buildStats(deduped, storeBytes, previewCount);
    }));
  }

  async drainForJob(jobId: string): Promise<JobNotification<TJob> | null> {
    return this.withStoreLock(async () => this.withFileLock(async () => {
      const { notifications, malformed, readFailed } = await this.readUnsafe();
      if (readFailed) {
        throw new Error("Failed to read persisted notifications before job-specific drain");
      }

      const deduped = this.dedupe(notifications);
      const target = deduped.find((notification) => notification.job.id === jobId) ?? null;
      if (!target && malformed === 0) {
        return null;
      }

      const remaining = deduped.filter((notification) => notification.job.id !== jobId);
      this.queue.splice(
        0,
        this.queue.length,
        ...this.dedupe(this.queue).filter((notification) => notification.job.id !== jobId),
      );

      try {
        await this.rewriteUnsafe(remaining);
      } catch (error) {
        this.warn(`failed to rewrite persisted notifications after job-specific drain: ${describeError(error)}`);
        throw error;
      }

      if (malformed > 0) {
        this.warn(
          `skipped ${malformed} malformed persisted notification entr${malformed === 1 ? "y" : "ies"} while draining job ${jobId}`,
        );
      }

      return target;
    }));
  }

  async drainAll(): Promise<Array<JobNotification<TJob>>> {
    return this.withStoreLock(async () => this.withFileLock(async () => {
      const { notifications, malformed, readFailed } = await this.readUnsafe();
      if (readFailed) {
        throw new Error("Failed to read persisted notifications before drain");
      }
      const pending = this.dedupe(notifications);
      this.queue.splice(0);
      if (malformed > 0) {
        this.warn(`skipped ${malformed} malformed persisted notification entr${malformed === 1 ? "y" : "ies"} while draining`);
      }
      try {
        await this.clearUnsafe();
      } catch (error) {
        this.warn(`failed to clear persisted notifications: ${describeError(error)}`);
      }
      return pending;
    }));
  }

  private withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(operation, operation);
    this.mutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const startedAt = Date.now();
    let attempt = 0;
    let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const lockToken = `${process.pid}:${randomUUID()}`;

    while (!lockHandle) {
      try {
        const acquired = await fs.open(this.lockPath, "wx");
        try {
          await acquired.writeFile(`${lockToken} ${new Date().toISOString()}\n`, "utf8");
        } catch (writeError) {
          await acquired.close().catch(() => undefined);
          await fs.rm(this.lockPath, { force: true }).catch(() => undefined);
          throw writeError;
        }
        lockHandle = acquired;
      } catch (error) {
        if (isFileExists(error)) {
          try {
            const stat = await fs.stat(this.lockPath);
            if (Date.now() - stat.mtimeMs > this.options.lockStaleMs) {
              await fs.rm(this.lockPath, { force: true });
              continue;
            }
          } catch (statError) {
            if (!isMissingFile(statError)) {
              this.warn(`failed to inspect notification lock: ${describeError(statError)}`);
            }
          }

          if (Date.now() - startedAt > this.options.lockTimeoutMs) {
            throw new Error(`Timed out waiting for notification store lock: ${this.lockPath}`);
          }

          attempt += 1;
          await sleep(Math.min(250, 25 + attempt * 25));
          continue;
        }

        throw error;
      }
    }

    try {
      return await operation();
    } finally {
      await lockHandle.close().catch(() => undefined);
      try {
        const contents = await fs.readFile(this.lockPath, "utf8");
        if (contents.startsWith(lockToken)) {
          await fs.rm(this.lockPath, { force: true });
        }
      } catch {
        // Lock file already removed or replaced; the next owner will clean up its own token.
      }
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(path.dirname(this.options.storePath), { recursive: true });
  }

  private async appendUnsafe(notification: JobNotification<TJob>): Promise<void> {
    await fs.appendFile(this.options.storePath, `${JSON.stringify(notification)}\n`, "utf8");
  }

  private async rewriteUnsafe(notifications: Array<JobNotification<TJob>>): Promise<void> {
    if (notifications.length === 0) {
      await this.clearUnsafe();
      return;
    }

    const tempPath = `${this.options.storePath}.${randomUUID()}.tmp`;
    const payload = notifications.map((notification) => JSON.stringify(notification)).join("\n");
    await fs.writeFile(tempPath, `${payload}\n`, "utf8");
    await fs.rename(tempPath, this.options.storePath);
  }

  private async clearUnsafe(): Promise<void> {
    await fs.rm(this.options.storePath, { force: true });
  }

  private async readUnsafe(): Promise<PersistedNotificationRead<TJob>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.options.storePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return { notifications: [], malformed: 0, readFailed: false };
      }
      this.warn(`failed to read persisted notifications: ${describeError(error)}`);
      return { notifications: [], malformed: 0, readFailed: true };
    }

    const notifications: Array<JobNotification<TJob>> = [];
    let malformed = 0;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const notification = this.options.normalizeNotification(JSON.parse(trimmed));
        if (notification) {
          notifications.push(notification);
        } else {
          malformed += 1;
        }
      } catch {
        malformed += 1;
      }
    }

    return { notifications, malformed, readFailed: false };
  }

  private notificationTime(notification: JobNotification<TJob>): number {
    const timestamp = Date.parse(notification.receivedAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private dedupe(notifications: Array<JobNotification<TJob>>): Array<JobNotification<TJob>> {
    const byJobId = new Map<string, JobNotification<TJob>>();
    for (const notification of notifications) {
      const existing = byJobId.get(notification.job.id);
      if (!existing || this.notificationTime(notification) >= this.notificationTime(existing)) {
        byJobId.set(notification.job.id, notification);
      }
    }

    return [...byJobId.values()].sort((left, right) => {
      const byTime = this.notificationTime(left) - this.notificationTime(right);
      return byTime === 0 ? left.job.id.localeCompare(right.job.id) : byTime;
    });
  }

  private retainWithinLimit(notifications: Array<JobNotification<TJob>>): {
    retained: Array<JobNotification<TJob>>;
    overflow: number;
  } {
    const overflow = Math.max(0, notifications.length - this.options.maxQueueSize);
    return {
      retained: overflow > 0 ? notifications.slice(overflow) : notifications,
      overflow,
    };
  }

  private async storeBytes(): Promise<number> {
    try {
      const stat = await fs.stat(this.options.storePath);
      return stat.size;
    } catch (error) {
      if (isMissingFile(error)) return 0;
      this.warn(`failed to stat persisted notifications: ${describeError(error)}`);
      return 0;
    }
  }

  private buildStats(
    notifications: Array<JobNotification<TJob>>,
    storeBytes: number,
    previewCount: number,
  ): NotificationStats<TJob["status"]> {
    const previewSize = Math.max(0, Math.min(this.options.previewMax, previewCount));
    const stats: NotificationStats<TJob["status"]> = {
      pending: notifications.length,
      dropped: this.dropped,
      storePath: this.options.storePath,
      storeBytes,
      oldestEnqueuedAt: notifications[0]?.receivedAt ?? null,
    };

    if (previewSize > 0) {
      stats.preview = notifications.slice(0, previewSize).map((notification) => ({
        jobId: notification.job.id,
        status: notification.job.status,
        receivedAt: notification.receivedAt,
        finishedAt: notification.job.finishedAt,
        stdoutPreview: notification.job.stdout.slice(0, this.options.previewTextMax),
        stderrPreview: notification.job.stderr.slice(0, this.options.previewTextMax),
      }));
    }

    return stats;
  }

  private warn(message: string): void {
    if (this.options.logWarning) {
      this.options.logWarning(message);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isFileExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
