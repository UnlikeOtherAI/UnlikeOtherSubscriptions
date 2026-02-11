import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { registerCorrelationId } from "./correlation-id.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerJwtAuth } from "./jwt-auth.js";

// Mock data
const TEST_APP_ID = "app-123";
const TEST_KID = "kid-abc";
const TEST_SECRET = "test-hmac-secret-key-that-is-long-enough";
const TEST_REVOKED_KID = "kid-revoked";

// Track created JTIs for replay testing
const usedJtis = new Map<string, Date>();

const { mockFindUnique, mockJtiCreate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockJtiCreate: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => ({
    appSecret: {
      findUnique: mockFindUnique,
    },
    jtiUsage: {
      create: mockJtiCreate,
    },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  }),
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/pg-boss.js", () => ({
  stopBoss: vi.fn(),
}));

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface JwtPayloadOptions {
  iss?: string;
  aud?: string;
  sub?: string;
  appId?: string;
  teamId?: string;
  userId?: string;
  scopes?: string[];
  iat?: number;
  exp?: number;
  jti?: string;
  kid?: string;
  reqHash?: string;
}

function createTestJwt(
  secret: string,
  kid: string,
  payloadOverrides: JwtPayloadOptions = {},
  headerOverrides: Record<string, unknown> = {}
): string {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "HS256",
    typ: "JWT",
    kid,
    ...headerOverrides,
  };

  const payload = {
    iss: `app:${TEST_APP_ID}`,
    aud: "billing-service",
    sub: `team:team-456`,
    appId: TEST_APP_ID,
    teamId: "team-456",
    userId: "user-789",
    scopes: ["usage:write", "billing:read"],
    iat: now,
    exp: now + 300,
    jti: uuidv4(),
    kid,
    ...payloadOverrides,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const signatureB64 = base64UrlEncode(signature);

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

function buildTestApp(): FastifyInstance {
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
  });

  registerCorrelationId(app);
  registerErrorHandler(app);
  registerJwtAuth(app);

  // A protected test route
  app.get("/v1/test/protected", async (request) => {
    return {
      claims: request.jwtClaims,
    };
  });

  // Health check - should bypass auth
  app.get("/healthz", async () => {
    return { status: "ok" };
  });

  // Stripe webhook - should bypass auth
  app.post("/v1/stripe/webhook", async () => {
    return { received: true };
  });

  return app;
}

function setupDefaultMocks(): void {
  mockFindUnique.mockImplementation(({ where }: { where: { kid: string } }) => {
    if (where.kid === TEST_KID) {
      return Promise.resolve({
        id: "secret-1",
        appId: TEST_APP_ID,
        kid: TEST_KID,
        secretHash: TEST_SECRET,
        status: "ACTIVE",
        createdAt: new Date(),
        revokedAt: null,
      });
    }
    if (where.kid === TEST_REVOKED_KID) {
      return Promise.resolve({
        id: "secret-2",
        appId: TEST_APP_ID,
        kid: TEST_REVOKED_KID,
        secretHash: TEST_SECRET,
        status: "REVOKED",
        createdAt: new Date(),
        revokedAt: new Date(),
      });
    }
    return Promise.resolve(null);
  });

  mockJtiCreate.mockImplementation(({ data }: { data: { jti: string; expiresAt: Date } }) => {
    if (usedJtis.has(data.jti)) {
      const error = new Error("Unique constraint violation") as Error & { code: string };
      error.code = "P2002";
      return Promise.reject(error);
    }
    usedJtis.set(data.jti, data.expiresAt);
    return Promise.resolve({ jti: data.jti, expiresAt: data.expiresAt });
  });
}

describe("JWT Auth middleware", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    usedJtis.clear();
    setupDefaultMocks();
    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows valid JWT and attaches claims to request", async () => {
    const token = createTestJwt(TEST_SECRET, TEST_KID);
    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.claims).toBeDefined();
    expect(body.claims.appId).toBe(TEST_APP_ID);
    expect(body.claims.teamId).toBe("team-456");
    expect(body.claims.userId).toBe("user-789");
    expect(body.claims.scopes).toEqual(["usage:write", "billing:read"]);
    expect(body.claims.kid).toBe(TEST_KID);
  });

  it("returns 401 for missing Authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBe("Unauthorized");
    expect(body.message).toBe("Missing Authorization header");
  });

  it("returns 401 for malformed Authorization header (not Bearer)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: "Basic abc123" },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Malformed Authorization header");
  });

  it("returns 401 for empty bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: "Bearer " },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Empty bearer token");
  });

  it("returns 401 for expired JWT", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createTestJwt(TEST_SECRET, TEST_KID, {
      iat: now - 600,
      exp: now - 300,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Token expired");
  });

  it("returns 401 for JWT with iat in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createTestJwt(TEST_SECRET, TEST_KID, {
      iat: now + 600,
      exp: now + 900,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Token issued in the future");
  });

  it("returns 401 for invalid signature", async () => {
    const token = createTestJwt("wrong-secret-key", TEST_KID);

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Invalid signature");
  });

  it("returns 401 for unknown kid", async () => {
    const token = createTestJwt(TEST_SECRET, "kid-unknown", { kid: "kid-unknown" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Unknown key ID");
  });

  it("returns 401 for revoked kid", async () => {
    const token = createTestJwt(TEST_SECRET, TEST_REVOKED_KID, { kid: TEST_REVOKED_KID });

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Key has been revoked");
  });

  it("returns 401 for replayed jti (duplicate token)", async () => {
    const jti = uuidv4();
    const token = createTestJwt(TEST_SECRET, TEST_KID, { jti });

    // First request should succeed
    const first = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);

    // Second request with same jti should fail
    const second = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(401);
    const body = second.json();
    expect(body.message).toBe("Token has already been used");
  });

  it("returns 401 for invalid audience", async () => {
    const token = createTestJwt(TEST_SECRET, TEST_KID, {
      aud: "wrong-service",
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Invalid audience");
  });

  it("returns 401 for invalid issuer format", async () => {
    const token = createTestJwt(TEST_SECRET, TEST_KID, {
      iss: "invalid-issuer",
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Invalid issuer");
  });

  it("returns 401 when issuer does not match appId", async () => {
    const token = createTestJwt(TEST_SECRET, TEST_KID, {
      iss: "app:different-app",
      appId: TEST_APP_ID,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Issuer does not match appId");
  });

  it("returns 401 for malformed JWT (not 3 parts)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: "Bearer not.a.valid.jwt.token" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for unsupported algorithm", async () => {
    const token = createTestJwt(TEST_SECRET, TEST_KID, {}, { alg: "RS256" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("Unsupported algorithm");
  });

  it("bypasses JWT check for /healthz route", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
  });

  it("bypasses JWT check for /v1/stripe/webhook route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/stripe/webhook",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.received).toBe(true);
  });

  it("includes requestId in 401 error responses", async () => {
    const customId = "custom-req-id-401";
    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { "x-request-id": customId },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.requestId).toBe(customId);
  });

  it("returns 401 when appId does not match key's appId", async () => {
    // Create a JWT with a different appId than what the key belongs to
    mockFindUnique.mockResolvedValueOnce({
      id: "secret-other",
      appId: "other-app-id",
      kid: TEST_KID,
      secretHash: TEST_SECRET,
      status: "ACTIVE",
      createdAt: new Date(),
      revokedAt: null,
    });

    const token = createTestJwt(TEST_SECRET, TEST_KID);

    const response = await app.inject({
      method: "GET",
      url: "/v1/test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe("appId does not match key");
  });
});
