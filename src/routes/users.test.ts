import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { createTestJwt, buildUserTestApp } from "./users-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();

// In-memory stores for mock data
let users: Map<string, Record<string, unknown>>;
let teams: Map<string, Record<string, unknown>>;
let billingEntities: Map<string, Record<string, unknown>>;
let teamMembers: Map<string, Record<string, unknown>>;

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn() },
    team: { create: vi.fn(), findFirst: vi.fn() },
    billingEntity: { create: vi.fn() },
    teamMember: { create: vi.fn() },
    appSecret: { findUnique: vi.fn() },
    jtiUsage: { create: vi.fn() },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/pg-boss.js", () => ({ stopBoss: vi.fn() }));

vi.mock("../lib/crypto.js", () => ({
  encryptSecret: (s: string) => `encrypted:${s}`,
  decryptSecret: (s: string) => s.replace("encrypted:", ""),
}));

function setupMocks(): void {
  // App lookup
  mockPrisma.app.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
    if (where.id === TEST_APP_ID) {
      return Promise.resolve({ id: TEST_APP_ID, name: "Test App", status: "ACTIVE" });
    }
    return Promise.resolve(null);
  });

  // AppSecret lookup for JWT auth
  mockPrisma.appSecret.findUnique.mockImplementation(({ where }: { where: { kid: string } }) => {
    if (where.kid === TEST_KID) {
      return Promise.resolve({
        id: uuidv4(),
        appId: TEST_APP_ID,
        kid: TEST_KID,
        secretHash: `encrypted:${TEST_SECRET}`,
        status: "ACTIVE",
      });
    }
    return Promise.resolve(null);
  });

  // JTI usage for replay protection
  mockPrisma.jtiUsage.create.mockResolvedValue({});

  // User lookup (by composite key)
  mockPrisma.user.findUnique.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
    if (where.appId_externalRef) {
      const key = where.appId_externalRef as { appId: string; externalRef: string };
      const compositeKey = `${key.appId}:${key.externalRef}`;
      return Promise.resolve(users.get(compositeKey) ?? null);
    }
    return Promise.resolve(null);
  });

  // Team findFirst for existing user's personal team
  mockPrisma.team.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
    for (const team of teams.values()) {
      if (team.kind === where.kind && team.ownerUserId === where.ownerUserId) {
        return Promise.resolve(team);
      }
    }
    return Promise.resolve(null);
  });

  // Transaction mock: execute the callback with the same mock prisma
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
    // Create a tx object that mirrors mockPrisma but with implementations for creates
    const tx = {
      user: {
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          const id = uuidv4();
          const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
          const compositeKey = `${data.appId}:${data.externalRef}`;
          users.set(compositeKey, record);
          return Promise.resolve(record);
        }),
      },
      team: {
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          const id = uuidv4();
          const record = { id, ...data, defaultCurrency: "USD", createdAt: new Date(), updatedAt: new Date() };
          teams.set(id, record);
          return Promise.resolve(record);
        }),
      },
      billingEntity: {
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          const id = uuidv4();
          const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
          billingEntities.set(id, record);
          return Promise.resolve(record);
        }),
      },
      teamMember: {
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          const id = uuidv4();
          const record = { id, ...data, startedAt: new Date() };
          teamMembers.set(id, record);
          return Promise.resolve(record);
        }),
      },
    };
    return fn(tx as unknown as typeof mockPrisma);
  });
}

function authHeaders(appIdOverride?: string): Record<string, string> {
  const jwt = createTestJwt(TEST_SECRET, TEST_KID, appIdOverride ?? TEST_APP_ID);
  return { authorization: `Bearer ${jwt}` };
}

describe("POST /v1/apps/:appId/users", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    users = new Map();
    teams = new Map();
    billingEntities = new Map();
    teamMembers = new Map();

    setupMocks();

    app = buildUserTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("creates User + Personal Team + BillingEntity + TeamMember on first call", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/users`,
      payload: { email: "alice@example.com", externalRef: "ext-user-1" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.user).toBeDefined();
    expect(body.user.id).toBeDefined();
    expect(body.user.appId).toBe(TEST_APP_ID);
    expect(body.user.email).toBe("alice@example.com");
    expect(body.user.externalRef).toBe("ext-user-1");
    expect(body.personalTeamId).toBeDefined();

    // Verify transaction was called
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();

    // Verify all records were created
    expect(users.size).toBe(1);
    expect(teams.size).toBe(1);
    expect(billingEntities.size).toBe(1);
    expect(teamMembers.size).toBe(1);

    // Verify team properties
    const team = [...teams.values()][0];
    expect(team.kind).toBe("PERSONAL");
    expect(team.billingMode).toBe("SUBSCRIPTION");
    expect(team.ownerUserId).toBe(body.user.id);

    // Verify billing entity
    const be = [...billingEntities.values()][0];
    expect(be.type).toBe("TEAM");
    expect(be.teamId).toBe(body.personalTeamId);

    // Verify team member
    const member = [...teamMembers.values()][0];
    expect(member.role).toBe("OWNER");
    expect(member.status).toBe("ACTIVE");
    expect(member.userId).toBe(body.user.id);
    expect(member.teamId).toBe(body.personalTeamId);
  });

  it("is idempotent — returns same IDs on second call with same externalRef", async () => {
    // First call: create user
    const response1 = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/users`,
      payload: { email: "alice@example.com", externalRef: "ext-user-1" },
      headers: authHeaders(),
    });

    expect(response1.statusCode).toBe(200);
    const body1 = response1.json();
    const userId = body1.user.id;
    const personalTeamId = body1.personalTeamId;

    // Second call: same externalRef, user already exists
    const response2 = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/users`,
      payload: { email: "alice@example.com", externalRef: "ext-user-1" },
      headers: authHeaders(),
    });

    expect(response2.statusCode).toBe(200);
    const body2 = response2.json();

    expect(body2.user.id).toBe(userId);
    expect(body2.personalTeamId).toBe(personalTeamId);

    // Transaction should only have been called once (for the first creation)
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
  });

  it("returns Personal Team with correct kind, owner, and billingMode", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/users`,
      payload: { email: "bob@example.com", externalRef: "ext-user-2" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    const team = [...teams.values()][0];
    expect(team.kind).toBe("PERSONAL");
    expect(team.ownerUserId).toBe(body.user.id);
    expect(team.billingMode).toBe("SUBSCRIPTION");
  });

  it("returns 403 when JWT appId does not match route appId", async () => {
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${differentAppId}/users`,
      payload: { email: "alice@example.com", externalRef: "ext-user-1" },
      headers: authHeaders(), // JWT has TEST_APP_ID, route has differentAppId
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toBe("JWT appId does not match route appId");
  });

  it("returns 400 for missing email", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/users`,
      payload: { externalRef: "ext-user-1" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid email", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/users`,
      payload: { email: "not-an-email", externalRef: "ext-user-1" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for missing externalRef", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/users`,
      payload: { email: "alice@example.com" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for empty externalRef", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/users`,
      payload: { email: "alice@example.com", externalRef: "" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 when App does not exist", async () => {
    const nonexistentAppId = uuidv4();

    // Override appSecret to return a secret for the nonexistent app so JWT passes
    mockPrisma.appSecret.findUnique.mockImplementation(({ where }: { where: { kid: string } }) => {
      if (where.kid === TEST_KID) {
        return Promise.resolve({
          id: uuidv4(),
          appId: nonexistentAppId,
          kid: TEST_KID,
          secretHash: `encrypted:${TEST_SECRET}`,
          status: "ACTIVE",
        });
      }
      return Promise.resolve(null);
    });

    const jwt = createTestJwt(TEST_SECRET, TEST_KID, nonexistentAppId);
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${nonexistentAppId}/users`,
      payload: { email: "alice@example.com", externalRef: "ext-user-1" },
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("App not found");
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/users`,
      payload: { email: "alice@example.com", externalRef: "ext-user-1" },
    });

    expect(response.statusCode).toBe(401);
  });
});
