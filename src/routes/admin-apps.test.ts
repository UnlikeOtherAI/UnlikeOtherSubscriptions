import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { createHmac, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { registerCorrelationId } from "../middleware/correlation-id.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { registerAdminAuth } from "../middleware/admin-auth.js";
import { registerJwtAuth } from "../middleware/jwt-auth.js";
import { adminAppRoutes } from "./admin-apps.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";

const TEST_ADMIN_API_KEY = "test-admin-api-key-for-testing";
const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");

// In-memory stores for mocked Prisma
let apps: Map<string, { id: string; name: string; status: string; createdAt: Date; updatedAt: Date }>;
let secrets: Map<string, { id: string; appId: string; kid: string; secretHash: string; status: string; createdAt: Date; revokedAt: Date | null }>;
let jtis: Map<string, Date>;

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    appSecret: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    jtiUsage: {
      create: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/pg-boss.js", () => ({
  stopBoss: vi.fn(),
}));

function setupInMemoryMocks(): void {
  apps = new Map();
  secrets = new Map();
  jtis = new Map();

  mockPrisma.app.create.mockImplementation(({ data }: { data: { name: string } }) => {
    const id = uuidv4();
    const app = { id, name: data.name, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() };
    apps.set(id, app);
    return Promise.resolve(app);
  });

  mockPrisma.app.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
    return Promise.resolve(apps.get(where.id) ?? null);
  });

  mockPrisma.appSecret.create.mockImplementation(({ data }: { data: { appId: string; kid: string; secretHash: string } }) => {
    const id = uuidv4();
    const secret = {
      id,
      appId: data.appId,
      kid: data.kid,
      secretHash: data.secretHash,
      status: "ACTIVE",
      createdAt: new Date(),
      revokedAt: null,
    };
    secrets.set(data.kid, secret);
    return Promise.resolve(secret);
  });

  mockPrisma.appSecret.findUnique.mockImplementation(({ where }: { where: { kid: string } }) => {
    return Promise.resolve(secrets.get(where.kid) ?? null);
  });

  mockPrisma.appSecret.update.mockImplementation(({ where, data }: { where: { kid: string }; data: { status: string; revokedAt: Date } }) => {
    const existing = secrets.get(where.kid);
    if (!existing) return Promise.reject(new Error("Not found"));
    const updated = { ...existing, ...data };
    secrets.set(where.kid, updated);
    return Promise.resolve(updated);
  });

  mockPrisma.jtiUsage.create.mockImplementation(({ data }: { data: { jti: string; expiresAt: Date } }) => {
    if (jtis.has(data.jti)) {
      const error = new Error("Unique constraint violation") as Error & { code: string };
      error.code = "P2002";
      return Promise.reject(error);
    }
    jtis.set(data.jti, data.expiresAt);
    return Promise.resolve({ jti: data.jti, expiresAt: data.expiresAt });
  });
}

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createTestJwt(
  secret: string,
  kid: string,
  appId: string,
  overrides: Record<string, unknown> = {}
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT", kid };
  const payload = {
    iss: `app:${appId}`,
    aud: "billing-service",
    sub: `team:team-456`,
    appId,
    teamId: "team-456",
    scopes: ["billing:read"],
    iat: now,
    exp: now + 300,
    jti: uuidv4(),
    kid,
    ...overrides,
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
  const app = Fastify({ logger: false, requestIdHeader: false });
  registerCorrelationId(app);
  registerErrorHandler(app);
  registerAdminAuth(app);
  registerJwtAuth(app);
  app.register(adminAppRoutes);

  // A protected route to test JWT auth with secrets
  app.get("/v1/test/protected", async (request) => {
    return { claims: request.jwtClaims };
  });

  return app;
}

function adminHeaders(): Record<string, string> {
  return { "x-admin-api-key": TEST_ADMIN_API_KEY };
}

describe("Admin App endpoints", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    setupInMemoryMocks();
    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  describe("POST /v1/admin/apps", () => {
    it("creates an App and returns valid appId", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "My Test App" },
        headers: adminHeaders(),
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe("string");
      expect(body.name).toBe("My Test App");
      expect(body.status).toBe("ACTIVE");
    });

    it("returns 400 for missing name", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: {},
        headers: adminHeaders(),
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 for empty name", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "" },
        headers: adminHeaders(),
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 403 without admin API key", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "No Auth" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe("Missing admin API key");
    });

    it("returns 403 with invalid admin API key", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "Bad Auth" },
        headers: { "x-admin-api-key": "wrong-key" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe("Invalid admin API key");
    });
  });

  describe("POST /v1/admin/apps/:appId/secrets", () => {
    it("generates a secret and returns kid + plaintext secret", async () => {
      // First create an app
      const createRes = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "Secret Test App" },
        headers: adminHeaders(),
      });
      const appId = createRes.json().id;

      const response = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.kid).toBeDefined();
      expect(typeof body.kid).toBe("string");
      expect(body.kid).toMatch(/^kid_/);
      expect(body.secret).toBeDefined();
      expect(typeof body.secret).toBe("string");
      expect(body.secret.length).toBeGreaterThan(0);
    });

    it("stores secret encrypted (not plaintext) in the database", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "Encryption Test App" },
        headers: adminHeaders(),
      });
      const appId = createRes.json().id;

      const secretRes = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });
      const { kid, secret: plaintextSecret } = secretRes.json();

      // Verify the stored secretHash is NOT the plaintext secret
      const storedSecret = secrets.get(kid);
      expect(storedSecret).toBeDefined();
      expect(storedSecret!.secretHash).not.toBe(plaintextSecret);

      // Verify it's in the encrypted format (iv:authTag:ciphertext)
      const parts = storedSecret!.secretHash.split(":");
      expect(parts.length).toBe(3);

      // Verify decrypting it yields the original plaintext
      const decrypted = decryptSecret(storedSecret!.secretHash);
      expect(decrypted).toBe(plaintextSecret);
    });

    it("returns 404 for nonexistent App", async () => {
      const fakeAppId = uuidv4();
      const response = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${fakeAppId}/secrets`,
        headers: adminHeaders(),
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe("Not Found");
      expect(body.message).toBe("App not found");
    });

    it("allows multiple active secrets per App", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "Multi Secret App" },
        headers: adminHeaders(),
      });
      const appId = createRes.json().id;

      const secret1Res = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });
      const secret2Res = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });

      expect(secret1Res.statusCode).toBe(201);
      expect(secret2Res.statusCode).toBe(201);

      const s1 = secret1Res.json();
      const s2 = secret2Res.json();

      expect(s1.kid).not.toBe(s2.kid);
      expect(s1.secret).not.toBe(s2.secret);
    });

    it("the secret can be used to sign a valid JWT that passes auth middleware", async () => {
      // Create app and generate secret
      const createRes = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "JWT Test App" },
        headers: adminHeaders(),
      });
      const appId = createRes.json().id;

      const secretRes = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });
      const { kid, secret } = secretRes.json();

      // Use the secret to create a JWT and hit a protected endpoint
      const token = createTestJwt(secret, kid, appId);

      const protectedRes = await app.inject({
        method: "GET",
        url: "/v1/test/protected",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(protectedRes.statusCode).toBe(200);
      const body = protectedRes.json();
      expect(body.claims.appId).toBe(appId);
      expect(body.claims.kid).toBe(kid);
    });

    it("multiple active secrets can each sign valid JWTs simultaneously", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "Rotation App" },
        headers: adminHeaders(),
      });
      const appId = createRes.json().id;

      const s1Res = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });
      const s2Res = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });

      const s1 = s1Res.json();
      const s2 = s2Res.json();

      // Both secrets should produce valid JWTs
      const token1 = createTestJwt(s1.secret, s1.kid, appId);
      const token2 = createTestJwt(s2.secret, s2.kid, appId);

      const res1 = await app.inject({
        method: "GET",
        url: "/v1/test/protected",
        headers: { authorization: `Bearer ${token1}` },
      });
      const res2 = await app.inject({
        method: "GET",
        url: "/v1/test/protected",
        headers: { authorization: `Bearer ${token2}` },
      });

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      expect(res1.json().claims.kid).toBe(s1.kid);
      expect(res2.json().claims.kid).toBe(s2.kid);
    });
  });

  describe("DELETE /v1/admin/apps/:appId/secrets/:kid", () => {
    it("revokes a secret successfully", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "Revoke Test App" },
        headers: adminHeaders(),
      });
      const appId = createRes.json().id;

      const secretRes = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });
      const { kid } = secretRes.json();

      const revokeRes = await app.inject({
        method: "DELETE",
        url: `/v1/admin/apps/${appId}/secrets/${kid}`,
        headers: adminHeaders(),
      });

      expect(revokeRes.statusCode).toBe(200);
      const body = revokeRes.json();
      expect(body.message).toBe("Secret revoked");
    });

    it("returns 404 when revoking a secret for nonexistent app", async () => {
      const fakeAppId = uuidv4();
      const response = await app.inject({
        method: "DELETE",
        url: `/v1/admin/apps/${fakeAppId}/secrets/kid_nonexistent`,
        headers: adminHeaders(),
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 for nonexistent kid", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "No Kid App" },
        headers: adminHeaders(),
      });
      const appId = createRes.json().id;

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/admin/apps/${appId}/secrets/kid_doesnotexist`,
        headers: adminHeaders(),
      });

      expect(response.statusCode).toBe(404);
    });

    it("revoking a secret causes JWTs signed with it to fail auth", async () => {
      // Create app and generate secret
      const createRes = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "Revoked Auth Test" },
        headers: adminHeaders(),
      });
      const appId = createRes.json().id;

      const secretRes = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });
      const { kid, secret } = secretRes.json();

      // Verify the secret works before revoking
      const token1 = createTestJwt(secret, kid, appId);
      const beforeRevoke = await app.inject({
        method: "GET",
        url: "/v1/test/protected",
        headers: { authorization: `Bearer ${token1}` },
      });
      expect(beforeRevoke.statusCode).toBe(200);

      // Revoke the secret
      await app.inject({
        method: "DELETE",
        url: `/v1/admin/apps/${appId}/secrets/${kid}`,
        headers: adminHeaders(),
      });

      // Now a JWT signed with the revoked secret should fail
      const token2 = createTestJwt(secret, kid, appId);
      const afterRevoke = await app.inject({
        method: "GET",
        url: "/v1/test/protected",
        headers: { authorization: `Bearer ${token2}` },
      });

      expect(afterRevoke.statusCode).toBe(401);
      expect(afterRevoke.json().message).toBe("Key has been revoked");
    });

    it("revoking is idempotent (revoking already revoked secret returns 200)", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/v1/admin/apps",
        payload: { name: "Idempotent Revoke" },
        headers: adminHeaders(),
      });
      const appId = createRes.json().id;

      const secretRes = await app.inject({
        method: "POST",
        url: `/v1/admin/apps/${appId}/secrets`,
        headers: adminHeaders(),
      });
      const { kid } = secretRes.json();

      // Revoke twice
      const first = await app.inject({
        method: "DELETE",
        url: `/v1/admin/apps/${appId}/secrets/${kid}`,
        headers: adminHeaders(),
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "DELETE",
        url: `/v1/admin/apps/${appId}/secrets/${kid}`,
        headers: adminHeaders(),
      });
      expect(second.statusCode).toBe(200);
    });

    it("returns 403 without admin API key for revoke", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/v1/admin/apps/some-app-id/secrets/some-kid",
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
