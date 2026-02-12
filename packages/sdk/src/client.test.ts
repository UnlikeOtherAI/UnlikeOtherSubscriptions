import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBillingClient } from "./client.js";
import { decodeJwt } from "./jwt.js";
import {
  BillingApiError,
  BillingValidationError,
} from "./errors.js";

const TEST_CONFIG = {
  appId: "app_test",
  secret: "test-secret-for-sdk",
  kid: "kid_test",
  baseUrl: "https://billing.example.com",
  maxRetries: 0,
  timeout: 5000,
};

function mockFetch(response: { status: number; body: unknown; headers?: Record<string, string> }) {
  const headers = new Map<string, string>(
    Object.entries({ "content-type": "application/json", ...response.headers })
  );

  return vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  });
}

describe("createBillingClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("reportUsage", () => {
    it("sends correctly formatted request with valid JWT", async () => {
      const fetchMock = mockFetch({ status: 200, body: { accepted: 1, duplicates: 0 } });
      globalThis.fetch = fetchMock;

      const client = createBillingClient(TEST_CONFIG);
      const events = [
        {
          idempotencyKey: "evt_1",
          eventType: "llm.tokens.v1",
          timestamp: "2025-01-01T00:00:00Z",
          teamId: "team_xyz",
          payload: { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50 },
          source: "test/1.0.0",
        },
      ];

      const result = await client.reportUsage(events);

      expect(result).toEqual({ accepted: 1, duplicates: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("https://billing.example.com/v1/apps/app_test/usage/events");
      expect(options.method).toBe("POST");

      // Verify JWT in Authorization header
      const authHeader = options.headers.Authorization as string;
      expect(authHeader).toMatch(/^Bearer /);
      const token = authHeader.replace("Bearer ", "");
      const { payload } = decodeJwt(token);
      expect(payload.appId).toBe("app_test");
      expect(payload.iss).toBe("app:app_test");
      expect(payload.aud).toBe("billing-service");
      expect(payload.teamId).toBe("team_xyz");
      expect(payload.kid).toBe("kid_test");
      expect(typeof payload.jti).toBe("string");
      expect(typeof payload.exp).toBe("number");
    });

    it("rejects empty events array", async () => {
      const client = createBillingClient(TEST_CONFIG);
      await expect(client.reportUsage([])).rejects.toThrow(BillingValidationError);
      await expect(client.reportUsage([])).rejects.toThrow("non-empty array");
    });

    it("enforces batch size validation client-side", async () => {
      const client = createBillingClient({ ...TEST_CONFIG, maxBatchSize: 2 });
      const events = Array.from({ length: 3 }, (_, i) => ({
        idempotencyKey: `evt_${i}`,
        eventType: "llm.tokens.v1",
        timestamp: "2025-01-01T00:00:00Z",
        teamId: "team_xyz",
        payload: { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50 },
        source: "test/1.0.0",
      }));

      await expect(client.reportUsage(events)).rejects.toThrow(BillingValidationError);
      await expect(client.reportUsage(events)).rejects.toThrow("exceeds maximum of 2");
    });

    it("handles API errors", async () => {
      globalThis.fetch = mockFetch({
        status: 400,
        body: { message: "Invalid eventType format", statusCode: 400 },
      });

      const client = createBillingClient(TEST_CONFIG);
      const events = [
        {
          idempotencyKey: "evt_1",
          eventType: "bad",
          timestamp: "2025-01-01T00:00:00Z",
          teamId: "team_xyz",
          payload: {},
          source: "test/1.0.0",
        },
      ];

      await expect(client.reportUsage(events)).rejects.toThrow(BillingApiError);
      try {
        await client.reportUsage(events);
      } catch (err) {
        expect((err as BillingApiError).statusCode).toBe(400);
        expect((err as BillingApiError).message).toBe("Invalid eventType format");
      }
    });
  });

  describe("getEntitlements", () => {
    it("returns typed entitlement result", async () => {
      const entitlements = {
        features: { "advanced-analytics": true },
        meterPolicies: {
          "llm.tokens.in": {
            limitType: "INCLUDED",
            includedAmount: 1000000,
            enforcement: "SOFT",
            overageBilling: "PER_UNIT",
          },
        },
        billingMode: "SUBSCRIPTION",
        billable: { "llm.tokens.in": true },
      };

      globalThis.fetch = mockFetch({ status: 200, body: entitlements });

      const client = createBillingClient(TEST_CONFIG);
      const result = await client.getEntitlements("team_xyz");

      expect(result).toEqual(entitlements);
      expect(result.billingMode).toBe("SUBSCRIPTION");
      expect(result.meterPolicies["llm.tokens.in"].limitType).toBe("INCLUDED");
    });

    it("sends GET request to correct URL", async () => {
      const fetchMock = mockFetch({
        status: 200,
        body: { features: {}, meterPolicies: {}, billingMode: "SUBSCRIPTION", billable: {} },
      });
      globalThis.fetch = fetchMock;

      const client = createBillingClient(TEST_CONFIG);
      await client.getEntitlements("team_xyz");

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("https://billing.example.com/v1/apps/app_test/teams/team_xyz/entitlements");
      expect(options.method).toBe("GET");
    });

    it("rejects empty teamId", async () => {
      const client = createBillingClient(TEST_CONFIG);
      await expect(client.getEntitlements("")).rejects.toThrow(BillingValidationError);
      await expect(client.getEntitlements("")).rejects.toThrow("teamId is required");
    });

    it("includes JWT with teamId in claims", async () => {
      const fetchMock = mockFetch({
        status: 200,
        body: { features: {}, meterPolicies: {}, billingMode: "SUBSCRIPTION", billable: {} },
      });
      globalThis.fetch = fetchMock;

      const client = createBillingClient(TEST_CONFIG);
      await client.getEntitlements("team_abc");

      const authHeader = fetchMock.mock.calls[0][1].headers.Authorization as string;
      const { payload } = decodeJwt(authHeader.replace("Bearer ", ""));
      expect(payload.teamId).toBe("team_abc");
    });

    it("handles 404 for nonexistent team", async () => {
      globalThis.fetch = mockFetch({
        status: 404,
        body: { message: "Team not found", statusCode: 404 },
      });

      const client = createBillingClient(TEST_CONFIG);
      await expect(client.getEntitlements("team_nonexistent")).rejects.toThrow(BillingApiError);
    });
  });

  describe("createCheckout", () => {
    it("returns checkout URL and session ID", async () => {
      globalThis.fetch = mockFetch({
        status: 200,
        body: { url: "https://checkout.stripe.com/c/pay_abc", sessionId: "cs_test_abc" },
      });

      const client = createBillingClient(TEST_CONFIG);
      const result = await client.createCheckout("team_xyz", {
        planCode: "pro",
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      });

      expect(result.url).toBe("https://checkout.stripe.com/c/pay_abc");
      expect(result.sessionId).toBe("cs_test_abc");
    });

    it("returns checkout result with only url (sessionId is optional)", async () => {
      globalThis.fetch = mockFetch({
        status: 200,
        body: { url: "https://checkout.stripe.com/c/pay_xyz" },
      });

      const client = createBillingClient(TEST_CONFIG);
      const result = await client.createCheckout("team_xyz", {
        planCode: "starter",
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      });

      expect(result.url).toBe("https://checkout.stripe.com/c/pay_xyz");
      expect(result.sessionId).toBeUndefined();
    });

    it("sends seat quantity to Stripe line items", async () => {
      const fetchMock = mockFetch({
        status: 200,
        body: { url: "https://checkout.stripe.com/c/pay_abc", sessionId: "cs_test_abc" },
      });
      globalThis.fetch = fetchMock;

      const client = createBillingClient(TEST_CONFIG);
      await client.createCheckout("team_xyz", {
        planCode: "pro",
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
        seats: 5,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.seats).toBe(5);
      expect(body.planCode).toBe("pro");
    });

    it("sends POST to correct URL", async () => {
      const fetchMock = mockFetch({
        status: 200,
        body: { url: "https://checkout.stripe.com/c/pay_abc", sessionId: "cs_test_abc" },
      });
      globalThis.fetch = fetchMock;

      const client = createBillingClient(TEST_CONFIG);
      await client.createCheckout("team_xyz", {
        planCode: "pro",
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "https://billing.example.com/v1/apps/app_test/teams/team_xyz/checkout/subscription"
      );
      expect(options.method).toBe("POST");
    });

    it("rejects missing planCode", async () => {
      const client = createBillingClient(TEST_CONFIG);
      await expect(
        client.createCheckout("team_xyz", {
          planCode: "",
          successUrl: "https://example.com/ok",
          cancelUrl: "https://example.com/cancel",
        })
      ).rejects.toThrow(BillingValidationError);
    });

    it("rejects missing successUrl", async () => {
      const client = createBillingClient(TEST_CONFIG);
      await expect(
        client.createCheckout("team_xyz", {
          planCode: "pro",
          successUrl: "",
          cancelUrl: "https://example.com/cancel",
        })
      ).rejects.toThrow(BillingValidationError);
    });

    it("rejects missing cancelUrl", async () => {
      const client = createBillingClient(TEST_CONFIG);
      await expect(
        client.createCheckout("team_xyz", {
          planCode: "pro",
          successUrl: "https://example.com/ok",
          cancelUrl: "",
        })
      ).rejects.toThrow(BillingValidationError);
    });

    it("rejects missing teamId", async () => {
      const client = createBillingClient(TEST_CONFIG);
      await expect(
        client.createCheckout("", {
          planCode: "pro",
          successUrl: "https://example.com/ok",
          cancelUrl: "https://example.com/cancel",
        })
      ).rejects.toThrow(BillingValidationError);
    });
  });

  describe("expired and revoked secret handling", () => {
    it("throws BillingApiError with status 401 for expired JWT", async () => {
      globalThis.fetch = mockFetch({
        status: 401,
        body: { message: "JWT has expired", statusCode: 401, error: "Unauthorized" },
        headers: { "x-request-id": "req_expired_jwt" },
      });

      const client = createBillingClient(TEST_CONFIG);

      try {
        await client.getEntitlements("team_xyz");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BillingApiError);
        const apiErr = err as BillingApiError;
        expect(apiErr.statusCode).toBe(401);
        expect(apiErr.message).toBe("JWT has expired");
        expect(apiErr.requestId).toBe("req_expired_jwt");
        expect(apiErr.name).toBe("BillingApiError");
      }
    });

    it("throws BillingApiError with status 401 for revoked secret (kid)", async () => {
      globalThis.fetch = mockFetch({
        status: 401,
        body: { message: "Secret has been revoked", statusCode: 401, error: "Unauthorized" },
        headers: { "x-request-id": "req_revoked_kid" },
      });

      const client = createBillingClient(TEST_CONFIG);

      try {
        await client.reportUsage([
          {
            idempotencyKey: "evt_revoked",
            eventType: "llm.tokens.v1",
            timestamp: "2025-01-01T00:00:00Z",
            teamId: "team_xyz",
            payload: { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50 },
            source: "test/1.0.0",
          },
        ]);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BillingApiError);
        const apiErr = err as BillingApiError;
        expect(apiErr.statusCode).toBe(401);
        expect(apiErr.message).toBe("Secret has been revoked");
        expect(apiErr.requestId).toBe("req_revoked_kid");
      }
    });

    it("does not retry 401 errors", async () => {
      const fetchMock = mockFetch({
        status: 401,
        body: { message: "Unauthorized", statusCode: 401 },
      });
      globalThis.fetch = fetchMock;

      const client = createBillingClient({ ...TEST_CONFIG, maxRetries: 3 });

      await expect(
        client.createCheckout("team_xyz", {
          planCode: "pro",
          successUrl: "https://app.example.com/success",
          cancelUrl: "https://app.example.com/cancel",
        })
      ).rejects.toThrow(BillingApiError);

      // 401 is not a retryable status code, so only 1 call should be made
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("base URL handling", () => {
    it("strips trailing slash from baseUrl", async () => {
      const fetchMock = mockFetch({
        status: 200,
        body: { features: {}, meterPolicies: {}, billingMode: "SUBSCRIPTION", billable: {} },
      });
      globalThis.fetch = fetchMock;

      const client = createBillingClient({ ...TEST_CONFIG, baseUrl: "https://billing.example.com/" });
      await client.getEntitlements("team_1");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://billing.example.com/v1/apps/app_test/teams/team_1/entitlements");
    });
  });
});
