import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { httpRequest } from "./http.js";
import {
  BillingApiError,
  BillingNetworkError,
  BillingTimeoutError,
} from "./errors.js";

describe("httpRequest", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchResponses(...responses: Array<{
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }>) {
    let callIndex = 0;
    return vi.fn().mockImplementation(() => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      const headers = new Map<string, string>(
        Object.entries({ "content-type": "application/json", ...resp.headers })
      );
      return Promise.resolve({
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: () => Promise.resolve(resp.body),
        text: () => Promise.resolve(JSON.stringify(resp.body)),
      });
    });
  }

  it("makes a successful GET request", async () => {
    const fetchMock = mockFetchResponses({ status: 200, body: { data: "ok" } });
    globalThis.fetch = fetchMock;

    const result = await httpRequest({
      method: "GET",
      url: "https://api.example.com/test",
      headers: { "Content-Type": "application/json" },
      timeout: 5000,
      maxRetries: 0,
    });

    expect(result).toEqual({ data: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes a successful POST request with body", async () => {
    const fetchMock = mockFetchResponses({ status: 201, body: { id: "123" } });
    globalThis.fetch = fetchMock;

    const result = await httpRequest({
      method: "POST",
      url: "https://api.example.com/items",
      headers: { "Content-Type": "application/json" },
      body: { name: "test" },
      timeout: 5000,
      maxRetries: 0,
    });

    expect(result).toEqual({ id: "123" });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.body).toBe('{"name":"test"}');
  });

  it("throws BillingApiError for non-retryable errors", async () => {
    globalThis.fetch = mockFetchResponses({
      status: 400,
      body: { message: "Bad request" },
    });

    await expect(
      httpRequest({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
        timeout: 5000,
        maxRetries: 2,
      })
    ).rejects.toThrow(BillingApiError);
  });

  it("does not retry 400 errors", async () => {
    const fetchMock = mockFetchResponses({ status: 400, body: { message: "bad" } });
    globalThis.fetch = fetchMock;

    await expect(
      httpRequest({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
        timeout: 5000,
        maxRetries: 2,
      })
    ).rejects.toThrow(BillingApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 and eventually succeeds", async () => {
    const fetchMock = mockFetchResponses(
      { status: 500, body: { message: "Internal error" } },
      { status: 500, body: { message: "Internal error" } },
      { status: 200, body: { data: "recovered" } }
    );
    globalThis.fetch = fetchMock;

    const result = await httpRequest({
      method: "GET",
      url: "https://api.example.com/test",
      headers: {},
      timeout: 5000,
      maxRetries: 2,
    });

    expect(result).toEqual({ data: "recovered" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 and eventually succeeds", async () => {
    const fetchMock = mockFetchResponses(
      { status: 429, body: { message: "Rate limited" } },
      { status: 200, body: { data: "ok" } }
    );
    globalThis.fetch = fetchMock;

    const result = await httpRequest({
      method: "GET",
      url: "https://api.example.com/test",
      headers: {},
      timeout: 5000,
      maxRetries: 1,
    });

    expect(result).toEqual({ data: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on 503", async () => {
    const fetchMock = mockFetchResponses(
      { status: 503, body: { message: "Unavailable" } },
      { status: 503, body: { message: "Unavailable" } },
      { status: 503, body: { message: "Unavailable" } }
    );
    globalThis.fetch = fetchMock;

    await expect(
      httpRequest({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
        timeout: 5000,
        maxRetries: 2,
      })
    ).rejects.toThrow(BillingApiError);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on network errors", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      const headers = new Map([["content-type", "application/json"]]);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name: string) => headers.get(name) ?? null },
        json: () => Promise.resolve({ data: "recovered" }),
        text: () => Promise.resolve('{"data":"recovered"}'),
      });
    });

    const result = await httpRequest({
      method: "GET",
      url: "https://api.example.com/test",
      headers: {},
      timeout: 5000,
      maxRetries: 2,
    });

    expect(result).toEqual({ data: "recovered" });
    expect(callCount).toBe(3);
  });

  it("throws BillingNetworkError after exhausting retries on network errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      httpRequest({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
        timeout: 5000,
        maxRetries: 1,
      })
    ).rejects.toThrow(BillingNetworkError);
  });

  it("throws BillingTimeoutError on timeout with no retries", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    await expect(
      httpRequest({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
        timeout: 100,
        maxRetries: 0,
      })
    ).rejects.toThrow(BillingTimeoutError);
  });

  it("includes requestId from response headers in BillingApiError", async () => {
    globalThis.fetch = mockFetchResponses({
      status: 401,
      body: { message: "Unauthorized" },
      headers: { "x-request-id": "req_abc123" },
    });

    try {
      await httpRequest({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
        timeout: 5000,
        maxRetries: 0,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingApiError);
      expect((err as BillingApiError).requestId).toBe("req_abc123");
    }
  });
});
