export type BridgeFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface BridgeClientOptions {
  baseUrl: string;
  apiToken?: string;
  timeoutMs: number;
  fetchImpl?: BridgeFetch;
}

export class BridgeClient {
  private readonly fetchImpl: BridgeFetch;

  constructor(private readonly options: BridgeClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async requestJson<T>(
    path: string,
    init?: RequestInit,
    signatureHeader?: string,
  ): Promise<T> {
    const response = await this.fetchWithTimeout(this.buildUrl(path), {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(this.options.apiToken ? { Authorization: `Bearer ${this.options.apiToken}` } : {}),
        ...(signatureHeader ? { "X-Callback-Signature": signatureHeader } : {}),
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    const data = text.length > 0 ? safeJsonParse(text) : null;

    if (!response.ok) {
      const details =
        data && typeof data === "object"
          ? JSON.stringify(data, null, 2)
          : text || response.statusText;
      throw new Error(`Bridge request failed (${response.status} ${response.statusText}): ${details}`);
    }

    return data as T;
  }

  private buildUrl(path: string): URL {
    return new URL(path, ensureTrailingSlash(this.options.baseUrl));
  }

  private async fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Bridge request timed out after ${this.options.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
