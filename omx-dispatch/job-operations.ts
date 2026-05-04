import type { BridgeClient } from "./bridge-client.js";
import type { JobNotification, NotificationStats } from "./notification-store.js";
import type {
  BridgeJob,
  BridgeJobSession,
  BridgeJobStats,
  CallbackJobInput,
  CreateJobResponse,
  DispatchHealthResult,
  JobStatus,
  SubmitJobInput,
  WaitForJobOptions,
  WaitForJobResult,
} from "./tool-handlers.js";

export interface JobOperationsConfig {
  bridgeUrl: string;
  callbackSecret: string;
  defaultNotifyUrl: () => string;
  defaultWaitTimeoutMs: number;
  defaultWaitPollIntervalMs: number;
  maxWaitTimeoutMs: number;
  minWaitPollIntervalMs: number;
  maxWaitPollIntervalMs: number;
  terminalNotificationGraceMs: number;
}

export interface JobOperationsDependencies {
  bridgeClient: Pick<BridgeClient, "requestJson">;
  getNotificationStats: (previewCount?: number) => Promise<NotificationStats<JobStatus>>;
  drainNotificationForJob: (jobId: string) => Promise<JobNotification<BridgeJob> | null>;
  buildCallbackSignatureHeader: (jobId: string, body: string) => string;
  describeError?: (error: unknown) => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class JobOperations {
  private readonly describeError: (error: unknown) => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly config: JobOperationsConfig,
    private readonly deps: JobOperationsDependencies,
  ) {
    this.describeError = deps.describeError ?? defaultDescribeError;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
  }

  async submitBridgeJob(input: SubmitJobInput): Promise<CreateJobResponse> {
    const { prompt, executionMode, cwd, requestId, originRoutingKey, metadata, notifyUrl, source, sourceName } = input;
    return this.requestJson<CreateJobResponse>("jobs", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        ...(executionMode ? { executionMode } : {}),
        ...(cwd ? { cwd } : {}),
        ...(requestId ? { requestId } : {}),
        ...(originRoutingKey ? { originRoutingKey } : {}),
        ...(metadata ? { metadata } : {}),
        ...(source ? { source } : {}),
        ...(sourceName ? { sourceName } : {}),
        notifyUrl: notifyUrl ?? this.config.defaultNotifyUrl(),
      }),
    });
  }

  async getBridgeJob(jobId: string): Promise<BridgeJob> {
    return this.requestJson<BridgeJob>(
      `jobs/${encodeURIComponent(jobId)}`,
      { method: "GET" },
    );
  }

  async getBridgeJobSession(jobId: string): Promise<BridgeJobSession> {
    return this.requestJson<BridgeJobSession>(
      `jobs/${encodeURIComponent(jobId)}/session`,
      { method: "GET" },
    );
  }

  async getBridgeJobStats(): Promise<BridgeJobStats> {
    return this.requestJson<BridgeJobStats>("jobs/stats", { method: "GET" });
  }

  async listBridgeJobs(status?: JobStatus): Promise<BridgeJob[]> {
    const search = new URLSearchParams();
    if (status) search.set("status", status);
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.requestJson<BridgeJob[]>(`jobs${suffix}`, { method: "GET" });
  }

  async cancelBridgeJob(jobId: string): Promise<BridgeJob> {
    return this.requestJson<BridgeJob>(
      `jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    );
  }

  async callbackBridgeJob(input: CallbackJobInput): Promise<BridgeJob> {
    const { jobId, status, stdout, stderr, exitCode } = input;
    const body = {
      status,
      ...(stdout !== undefined ? { stdout } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
    const bodyText = JSON.stringify(body);
    const signatureHeader = this.config.callbackSecret
      ? this.deps.buildCallbackSignatureHeader(jobId, bodyText)
      : undefined;
    return this.requestJson<BridgeJob>(
      `jobs/${encodeURIComponent(jobId)}/callback`,
      { method: "POST", body: bodyText },
      signatureHeader,
    );
  }

  async getDispatchHealth(): Promise<DispatchHealthResult> {
    const notifications = await this.deps.getNotificationStats();
    try {
      const stats = await this.getBridgeJobStats();
      return {
        bridge: {
          reachable: true,
          url: this.config.bridgeUrl,
          stats,
        },
        notifications,
      };
    } catch (error) {
      return {
        bridge: {
          reachable: false,
          url: this.config.bridgeUrl,
          error: this.describeError(error),
        },
        notifications,
      };
    }
  }

  async waitForJobCompletion(
    jobId: string,
    options: WaitForJobOptions = {},
  ): Promise<WaitForJobResult> {
    const { waitTimeoutMs, pollIntervalMs } = this.resolveWaitOptions(options);
    const deadline = this.now() + waitTimeoutMs;
    let latestJob = await this.getBridgeJob(jobId);
    let terminalObservedAt: number | undefined;

    while (true) {
      const notification = await this.deps.drainNotificationForJob(jobId);
      if (notification) {
        return {
          jobId,
          status: notification.job.status,
          completed: isTerminalJobStatus(notification.job.status),
          timedOut: false,
          notification,
          job: notification.job,
        };
      }

      latestJob = await this.getBridgeJob(jobId);
      if (isTerminalJobStatus(latestJob.status)) {
        terminalObservedAt ??= this.now();
        if (this.now() - terminalObservedAt >= this.config.terminalNotificationGraceMs) {
          return {
            jobId,
            status: latestJob.status,
            completed: true,
            timedOut: false,
            notification: null,
            job: latestJob,
            notificationMissing: true,
          };
        }
      } else {
        terminalObservedAt = undefined;
      }

      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        return {
          jobId,
          status: latestJob.status,
          completed: isTerminalJobStatus(latestJob.status),
          timedOut: !isTerminalJobStatus(latestJob.status),
          notification: null,
          job: latestJob,
          ...(isTerminalJobStatus(latestJob.status) ? { notificationMissing: true } : {}),
        };
      }

      const nextDelay = terminalObservedAt !== undefined
        ? Math.min(remainingMs, this.config.minWaitPollIntervalMs)
        : Math.min(remainingMs, pollIntervalMs);
      await this.sleep(nextDelay);
    }
  }

  private resolveWaitOptions(options: WaitForJobOptions): {
    waitTimeoutMs: number;
    pollIntervalMs: number;
  } {
    return {
      waitTimeoutMs: clampNumber(
        options.waitTimeoutMs,
        this.config.defaultWaitTimeoutMs,
        1,
        this.config.maxWaitTimeoutMs,
      ),
      pollIntervalMs: clampNumber(
        options.pollIntervalMs,
        this.config.defaultWaitPollIntervalMs,
        this.config.minWaitPollIntervalMs,
        this.config.maxWaitPollIntervalMs,
      ),
    };
  }

  private requestJson<T>(
    path: string,
    init?: RequestInit,
    signatureHeader?: string,
  ): Promise<T> {
    return this.deps.bridgeClient.requestJson<T>(path, init, signatureHeader);
  }
}

function isTerminalJobStatus(value: JobStatus): boolean {
  return value === "succeeded" || value === "failed" || value === "cancelled";
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(min, Math.min(max, fallback));
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function defaultDescribeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
