import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { decryptSecret } from "../lib/crypto.js";
import {
  TEST_ADMIN_API_KEY,
  adminHeaders,
  createTestJwt,
  buildTestApp,
} from "./admin-apps-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");

let apps: Map<string, { id: string; name: string; status: string; createdAt: Date; updatedAt: Date }>;
let secrets: Map<string, { id: string; appId: string; kid: string; secretHash: string; status: string; createdAt: Date; revokedAt: Date | null }>;
let jtis: Map<string, Date>;

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: { create: vi.fn(), findUnique: vi.fn() },
    appSecret: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    jtiUsage: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/pg-boss.js", () => ({ stopBoss: vi.fn() }));

function setupMocks(): void {
  apps = new Map();
  secrets = new Map();
  jtis = new Map();

  mockPrisma.app.create.mockImplementation(({ data }: { data: { name: string } }) => {
    const id = uuidv4();
    const record = { id, name: data.name, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() };
    apps.set(id, record);
    return Promise.resolve(record);
  });

  mockPrisma.app.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(apps.get(where.id) ?? null));

  mockPrisma.appSecret.create.mockImplementation(({ data }: { data: { appId: string; kid: string; secretHash: string } }) => {
    const id = uuidv4();
    const secret = { id, appId: data.appId, kid: data.kid, secretHash: data.secretHash, status: "ACTIVE", createdAt: new Date(), revokedAt: null };
    secrets.set(data.kid, secret);
    return Promise.resolve(secret);
  });

  mockPrisma.appSecret.findUnique.mockImplementation(({ where }: { where: { kid: string } }) =>
    Promise.resolve(secrets.get(where.kid) ?? null));

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

describe("POST /v1/admin/apps/:appId/secrets", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    setupMocks();
    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  async function createApp(name: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/v1/admin/apps", payload: { name }, headers: adminHeaders() });
    return res.json().id;
  }

  it("generates a secret and returns kid + plaintext secret", async () => {
    const appId = await createApp("Secret Test App");

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
    const appId = await createApp("Encryption Test App");

    const secretRes = await app.inject({
      method: "POST",
      url: `/v1/admin/apps/${appId}/secrets`,
      headers: adminHeaders(),
    });
    const { kid, secret: plaintextSecret } = secretRes.json();

    const storedSecret = secrets.get(kid);
    expect(storedSecret).toBeDefined();
    expect(storedSecret!.secretHash).not.toBe(plaintextSecret);

    const parts = storedSecret!.secretHash.split(":");
    expect(parts.length).toBe(3);

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

  it("returns 403 without admin API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps/some-app-id/secrets",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Missing admin API key");
  });

  it("allows multiple active secrets per App", async () => {
    const appId = await createApp("Multi Secret App");

    const secret1Res = await app.inject({ method: "POST", url: `/v1/admin/apps/${appId}/secrets`, headers: adminHeaders() });
    const secret2Res = await app.inject({ method: "POST", url: `/v1/admin/apps/${appId}/secrets`, headers: adminHeaders() });

    expect(secret1Res.statusCode).toBe(201);
    expect(secret2Res.statusCode).toBe(201);

    const s1 = secret1Res.json();
    const s2 = secret2Res.json();
    expect(s1.kid).not.toBe(s2.kid);
    expect(s1.secret).not.toBe(s2.secret);
  });

  it("the secret can be used to sign a valid JWT that passes auth middleware", async () => {
    const appId = await createApp("JWT Test App");

    const secretRes = await app.inject({
      method: "POST",
      url: `/v1/admin/apps/${appId}/secrets`,
      headers: adminHeaders(),
    });
    const { kid, secret } = secretRes.json();

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
    const appId = await createApp("Rotation App");

    const s1Res = await app.inject({ method: "POST", url: `/v1/admin/apps/${appId}/secrets`, headers: adminHeaders() });
    const s2Res = await app.inject({ method: "POST", url: `/v1/admin/apps/${appId}/secrets`, headers: adminHeaders() });

    const s1 = s1Res.json();
    const s2 = s2Res.json();

    const token1 = createTestJwt(s1.secret, s1.kid, appId);
    const token2 = createTestJwt(s2.secret, s2.kid, appId);

    const res1 = await app.inject({ method: "GET", url: "/v1/test/protected", headers: { authorization: `Bearer ${token1}` } });
    const res2 = await app.inject({ method: "GET", url: "/v1/test/protected", headers: { authorization: `Bearer ${token2}` } });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res1.json().claims.kid).toBe(s1.kid);
    expect(res2.json().claims.kid).toBe(s2.kid);
  });
});
