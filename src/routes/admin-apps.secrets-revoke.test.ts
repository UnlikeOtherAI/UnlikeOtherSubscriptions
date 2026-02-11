import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
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

describe("DELETE /v1/admin/apps/:appId/secrets/:kid", () => {
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

  async function createSecret(appId: string): Promise<{ kid: string; secret: string }> {
    const res = await app.inject({ method: "POST", url: `/v1/admin/apps/${appId}/secrets`, headers: adminHeaders() });
    return res.json();
  }

  it("revokes a secret successfully", async () => {
    const appId = await createApp("Revoke Test App");
    const { kid } = await createSecret(appId);

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
    const appId = await createApp("No Kid App");

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/admin/apps/${appId}/secrets/kid_doesnotexist`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("revoking a secret causes JWTs signed with it to fail auth", async () => {
    const appId = await createApp("Revoked Auth Test");
    const { kid, secret } = await createSecret(appId);

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
    const appId = await createApp("Idempotent Revoke");
    const { kid } = await createSecret(appId);

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
