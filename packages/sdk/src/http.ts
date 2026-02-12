import { BillingApiError, BillingNetworkError, BillingTimeoutError } from "./errors.js";

export interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeout: number;
  maxRetries: number;
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const BASE_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number): number {
  // Exponential backoff with jitter
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = delay * 0.2 * Math.random();
  return delay + jitter;
}

/**
 * Makes an HTTP request with retry and timeout support.
 * Uses the built-in Node.js fetch API (Node 20+).
 */
export async function httpRequest<T>(options: HttpRequestOptions): Promise<T> {
  const { method, url, headers, body, timeout, maxRetries } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(getRetryDelay(attempt - 1));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);

      clearTimeout(timeoutId);

      let responseBody: unknown;
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      if (!response.ok) {
        const requestId = response.headers.get("x-request-id") ?? undefined;
        const error = new BillingApiError(response.status, responseBody, requestId);

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) {
          lastError = error;
          continue;
        }

        throw error;
      }

      return responseBody as T;
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof BillingApiError) {
        throw err;
      }

      if (err instanceof Error && err.name === "AbortError") {
        const timeoutErr = new BillingTimeoutError(timeout);
        if (attempt < maxRetries) {
          lastError = timeoutErr;
          continue;
        }
        throw timeoutErr;
      }

      const networkErr = new BillingNetworkError(
        err instanceof Error ? err.message : "Network error",
        err instanceof Error ? err : undefined
      );

      if (attempt < maxRetries) {
        lastError = networkErr;
        continue;
      }

      throw networkErr;
    }
  }

  // Should not reach here, but just in case
  throw lastError ?? new BillingNetworkError("Request failed after all retries");
}
