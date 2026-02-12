import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createBillingClient } from "./client.js";
import { decodeJwt } from "./jwt.js";
import { BillingApiError } from "./errors.js";

const TEST_SECRET = "integration-test-secret";
const TEST_KID = "kid_int";
const TEST_APP_ID = "app_integration";

let server: Server;
let baseUrl: string;

/**
 * Collects the full request body from an IncomingMessage.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * A simple mock billing API server that validates JWT auth
 * and responds to the core SDK endpoints.
 */
function createMockBillingServer(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-request-id", "req_integration_test");

    // Validate JWT Authorization header on all routes
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.writeHead(401);
      res.end(JSON.stringify({ message: "Missing authorization", statusCode: 401 }));
      return;
    }

    const token = authHeader.replace("Bearer ", "");
    let claims;
    try {
      const decoded = decodeJwt(token);
      claims = decoded.payload;
    } catch {
      res.writeHead(401);
      res.end(JSON.stringify({ message: "Invalid JWT", statusCode: 401 }));
      return;
    }

    // Validate standard claims
    if (claims.iss !== `app:${TEST_APP_ID}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ message: "Invalid issuer", statusCode: 401 }));
      return;
    }

    if (claims.aud !== "billing-service") {
      res.writeHead(401);
      res.end(JSON.stringify({ message: "Invalid audience", statusCode: 401 }));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) {
      res.writeHead(401);
      res.end(JSON.stringify({ message: "JWT has expired", statusCode: 401 }));
      return;
    }

    // Route: POST /v1/apps/:appId/usage/events
    const usageMatch = url.match(
      /^\/v1\/apps\/([^/]+)\/usage\/events$/
    );
    if (method === "POST" && usageMatch) {
      const body = await readBody(req);
      const events = JSON.parse(body);

      if (!Array.isArray(events)) {
        res.writeHead(400);
        res.end(JSON.stringify({ message: "events must be an array", statusCode: 400 }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ accepted: events.length, duplicates: 0 }));
      return;
    }

    // Route: GET /v1/apps/:appId/teams/:teamId/entitlements
    const entitlementsMatch = url.match(
      /^\/v1\/apps\/([^/]+)\/teams\/([^/]+)\/entitlements$/
    );
    if (method === "GET" && entitlementsMatch) {
      const teamId = entitlementsMatch[2];

      if (teamId === "team_nonexistent") {
        res.writeHead(404);
        res.end(JSON.stringify({ message: "Team not found", statusCode: 404 }));
        return;
      }

      res.writeHead(200);
      res.end(
        JSON.stringify({
          features: { "advanced-analytics": true, "export": false },
          meterPolicies: {
            "llm.tokens.in": {
              limitType: "INCLUDED",
              includedAmount: 500000,
              enforcement: "SOFT",
              overageBilling: "PER_UNIT",
            },
          },
          billingMode: "SUBSCRIPTION",
          billable: { "llm.tokens.in": true },
        })
      );
      return;
    }

    // Route: POST /v1/apps/:appId/teams/:teamId/checkout/subscription
    const checkoutMatch = url.match(
      /^\/v1\/apps\/([^/]+)\/teams\/([^/]+)\/checkout\/subscription$/
    );
    if (method === "POST" && checkoutMatch) {
      const teamId = checkoutMatch[2];

      if (teamId === "team_nonexistent") {
        res.writeHead(404);
        res.end(JSON.stringify({ message: "Team not found", statusCode: 404 }));
        return;
      }

      const body = await readBody(req);
      const payload = JSON.parse(body);

      if (!payload.planCode) {
        res.writeHead(400);
        res.end(JSON.stringify({ message: "planCode is required", statusCode: 400 }));
        return;
      }

      res.writeHead(200);
      res.end(
        JSON.stringify({
          url: `https://checkout.stripe.com/c/pay_${teamId}_${payload.planCode}`,
          sessionId: `cs_test_${teamId}_${payload.planCode}`,
        })
      );
      return;
    }

    // Fallback: 404
    res.writeHead(404);
    res.end(JSON.stringify({ message: "Not found", statusCode: 404 }));
  });
}

describe("SDK Integration Tests", () => {
  beforeAll(async () => {
    server = createMockBillingServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("reportUsage round-trip", () => {
    it("sends usage events and receives accepted count", async () => {
      const client = createBillingClient({
        appId: TEST_APP_ID,
        secret: TEST_SECRET,
        kid: TEST_KID,
        baseUrl,
        maxRetries: 0,
        timeout: 5000,
      });

      const result = await client.reportUsage([
        {
          idempotencyKey: "int_evt_1",
          eventType: "llm.tokens.v1",
          timestamp: new Date().toISOString(),
          teamId: "team_int_1",
          payload: { provider: "openai", model: "gpt-5", inputTokens: 200, outputTokens: 100 },
          source: "integration-test/1.0.0",
        },
        {
          idempotencyKey: "int_evt_2",
          eventType: "storage.bytes.v1",
          timestamp: new Date().toISOString(),
          teamId: "team_int_1",
          payload: { bytes: 1024 },
          source: "integration-test/1.0.0",
        },
      ]);

      expect(result.accepted).toBe(2);
      expect(result.duplicates).toBe(0);
    });
  });

  describe("getEntitlements round-trip", () => {
    it("retrieves entitlements for a valid team", async () => {
      const client = createBillingClient({
        appId: TEST_APP_ID,
        secret: TEST_SECRET,
        kid: TEST_KID,
        baseUrl,
        maxRetries: 0,
        timeout: 5000,
      });

      const result = await client.getEntitlements("team_int_1");

      expect(result.billingMode).toBe("SUBSCRIPTION");
      expect(result.features["advanced-analytics"]).toBe(true);
      expect(result.features["export"]).toBe(false);
      expect(result.meterPolicies["llm.tokens.in"]).toEqual({
        limitType: "INCLUDED",
        includedAmount: 500000,
        enforcement: "SOFT",
        overageBilling: "PER_UNIT",
      });
      expect(result.billable["llm.tokens.in"]).toBe(true);
    });

    it("throws BillingApiError with 404 for nonexistent team", async () => {
      const client = createBillingClient({
        appId: TEST_APP_ID,
        secret: TEST_SECRET,
        kid: TEST_KID,
        baseUrl,
        maxRetries: 0,
        timeout: 5000,
      });

      try {
        await client.getEntitlements("team_nonexistent");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BillingApiError);
        expect((err as BillingApiError).statusCode).toBe(404);
        expect((err as BillingApiError).message).toBe("Team not found");
      }
    });
  });

  describe("createCheckout round-trip", () => {
    it("creates a checkout session and returns url", async () => {
      const client = createBillingClient({
        appId: TEST_APP_ID,
        secret: TEST_SECRET,
        kid: TEST_KID,
        baseUrl,
        maxRetries: 0,
        timeout: 5000,
      });

      const result = await client.createCheckout("team_int_1", {
        planCode: "pro",
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
        seats: 10,
      });

      expect(result.url).toBe("https://checkout.stripe.com/c/pay_team_int_1_pro");
      expect(result.sessionId).toBe("cs_test_team_int_1_pro");
    });

    it("returns url without sessionId when server omits it", async () => {
      // Create a dedicated server that returns only { url }
      const minimalServer = createServer(async (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("x-request-id", "req_minimal");
        res.writeHead(200);
        res.end(JSON.stringify({ url: "https://checkout.stripe.com/c/pay_minimal" }));
      });

      const minimalBaseUrl = await new Promise<string>((resolve) => {
        minimalServer.listen(0, "127.0.0.1", () => {
          const addr = minimalServer.address();
          if (addr && typeof addr === "object") {
            resolve(`http://127.0.0.1:${addr.port}`);
          }
        });
      });

      try {
        const client = createBillingClient({
          appId: TEST_APP_ID,
          secret: TEST_SECRET,
          kid: TEST_KID,
          baseUrl: minimalBaseUrl,
          maxRetries: 0,
          timeout: 5000,
        });

        const result = await client.createCheckout("team_xyz", {
          planCode: "starter",
          successUrl: "https://app.example.com/success",
          cancelUrl: "https://app.example.com/cancel",
        });

        expect(result.url).toBe("https://checkout.stripe.com/c/pay_minimal");
        expect(result.sessionId).toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => {
          minimalServer.close(() => resolve());
        });
      }
    });

    it("throws BillingApiError with 404 for nonexistent team", async () => {
      const client = createBillingClient({
        appId: TEST_APP_ID,
        secret: TEST_SECRET,
        kid: TEST_KID,
        baseUrl,
        maxRetries: 0,
        timeout: 5000,
      });

      try {
        await client.createCheckout("team_nonexistent", {
          planCode: "pro",
          successUrl: "https://app.example.com/success",
          cancelUrl: "https://app.example.com/cancel",
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BillingApiError);
        expect((err as BillingApiError).statusCode).toBe(404);
      }
    });
  });

  describe("authentication error handling", () => {
    it("throws BillingApiError with 401 when no auth header is sent", async () => {
      // Create a server that always returns 401
      const authServer = createServer(async (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("x-request-id", "req_auth_fail");
        res.writeHead(401);
        res.end(JSON.stringify({ message: "JWT has expired", statusCode: 401 }));
      });

      const authBaseUrl = await new Promise<string>((resolve) => {
        authServer.listen(0, "127.0.0.1", () => {
          const addr = authServer.address();
          if (addr && typeof addr === "object") {
            resolve(`http://127.0.0.1:${addr.port}`);
          }
        });
      });

      try {
        const client = createBillingClient({
          appId: TEST_APP_ID,
          secret: TEST_SECRET,
          kid: TEST_KID,
          baseUrl: authBaseUrl,
          maxRetries: 0,
          timeout: 5000,
        });

        try {
          await client.getEntitlements("team_xyz");
          expect.fail("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(BillingApiError);
          const apiErr = err as BillingApiError;
          expect(apiErr.statusCode).toBe(401);
          expect(apiErr.message).toBe("JWT has expired");
          expect(apiErr.requestId).toBe("req_auth_fail");
        }
      } finally {
        await new Promise<void>((resolve) => {
          authServer.close(() => resolve());
        });
      }
    });

    it("throws BillingApiError with 401 for revoked secret", async () => {
      const revokedServer = createServer(async (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("x-request-id", "req_revoked");
        res.writeHead(401);
        res.end(JSON.stringify({ message: "Secret has been revoked", statusCode: 401 }));
      });

      const revokedBaseUrl = await new Promise<string>((resolve) => {
        revokedServer.listen(0, "127.0.0.1", () => {
          const addr = revokedServer.address();
          if (addr && typeof addr === "object") {
            resolve(`http://127.0.0.1:${addr.port}`);
          }
        });
      });

      try {
        const client = createBillingClient({
          appId: TEST_APP_ID,
          secret: "revoked-secret",
          kid: "kid_revoked",
          baseUrl: revokedBaseUrl,
          maxRetries: 0,
          timeout: 5000,
        });

        try {
          await client.reportUsage([
            {
              idempotencyKey: "evt_revoked_1",
              eventType: "llm.tokens.v1",
              timestamp: new Date().toISOString(),
              teamId: "team_xyz",
              payload: { provider: "openai", model: "gpt-5", inputTokens: 50, outputTokens: 25 },
              source: "integration-test/1.0.0",
            },
          ]);
          expect.fail("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(BillingApiError);
          const apiErr = err as BillingApiError;
          expect(apiErr.statusCode).toBe(401);
          expect(apiErr.message).toBe("Secret has been revoked");
          expect(apiErr.requestId).toBe("req_revoked");
        }
      } finally {
        await new Promise<void>((resolve) => {
          revokedServer.close(() => resolve());
        });
      }
    });
  });

  describe("JWT verification on server", () => {
    it("sends JWT with correct claims to the server", async () => {
      // Create a server that captures and validates JWT claims
      let capturedClaims: Record<string, unknown> | null = null;

      const jwtServer = createServer(async (req, res) => {
        const authHeader = req.headers["authorization"];
        if (authHeader) {
          const token = authHeader.replace("Bearer ", "");
          const decoded = decodeJwt(token);
          capturedClaims = decoded.payload as unknown as Record<string, unknown>;
        }

        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            features: {},
            meterPolicies: {},
            billingMode: "SUBSCRIPTION",
            billable: {},
          })
        );
      });

      const jwtBaseUrl = await new Promise<string>((resolve) => {
        jwtServer.listen(0, "127.0.0.1", () => {
          const addr = jwtServer.address();
          if (addr && typeof addr === "object") {
            resolve(`http://127.0.0.1:${addr.port}`);
          }
        });
      });

      try {
        const client = createBillingClient({
          appId: TEST_APP_ID,
          secret: TEST_SECRET,
          kid: TEST_KID,
          baseUrl: jwtBaseUrl,
          maxRetries: 0,
          timeout: 5000,
        });

        await client.getEntitlements("team_verify");

        expect(capturedClaims).not.toBeNull();
        expect(capturedClaims!.appId).toBe(TEST_APP_ID);
        expect(capturedClaims!.iss).toBe(`app:${TEST_APP_ID}`);
        expect(capturedClaims!.aud).toBe("billing-service");
        expect(capturedClaims!.teamId).toBe("team_verify");
        expect(capturedClaims!.kid).toBe(TEST_KID);
        expect(capturedClaims!.sub).toBe("team:team_verify");
        expect(typeof capturedClaims!.jti).toBe("string");
        expect(typeof capturedClaims!.exp).toBe("number");
        expect(typeof capturedClaims!.iat).toBe("number");
      } finally {
        await new Promise<void>((resolve) => {
          jwtServer.close(() => resolve());
        });
      }
    });
  });
});
