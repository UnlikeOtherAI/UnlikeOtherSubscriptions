import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { createTestJwt, buildTeamTestApp } from "./teams-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();

const EXISTING_TEAM_ID = uuidv4();
const EXISTING_TEAM = {
  id: EXISTING_TEAM_ID,
  name: "Existing Team",
  kind: "STANDARD",
  billingMode: "SUBSCRIPTION",
  defaultCurrency: "USD",
  stripeCustomerId: "cus_test123",
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-02T00:00:00Z"),
};

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    externalTeamRef: { findUnique: vi.fn() },
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

  // Team findUnique
  mockPrisma.team.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
    if (where.id === EXISTING_TEAM_ID) {
      return Promise.resolve(EXISTING_TEAM);
    }
    return Promise.resolve(null);
  });
}

function authHeaders(appIdOverride?: string): Record<string, string> {
  const jwt = createTestJwt(TEST_SECRET, TEST_KID, appIdOverride ?? TEST_APP_ID);
  return { authorization: `Bearer ${jwt}` };
}

describe("GET /v1/apps/:appId/teams/:teamId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    setupMocks();

    app = buildTeamTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("returns Team details with correct fields", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${EXISTING_TEAM_ID}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.id).toBe(EXISTING_TEAM_ID);
    expect(body.name).toBe("Existing Team");
    expect(body.kind).toBe("STANDARD");
    expect(body.billingMode).toBe("SUBSCRIPTION");
    expect(body.defaultCurrency).toBe("USD");
    expect(body.stripeCustomerId).toBe("cus_test123");
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  it("returns 404 when Team does not exist", async () => {
    const nonexistentTeamId = uuidv4();
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${nonexistentTeamId}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("Team not found");
  });

  it("returns 403 when JWT appId does not match route appId", async () => {
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${differentAppId}/teams/${EXISTING_TEAM_ID}`,
      headers: authHeaders(), // JWT has TEST_APP_ID
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toBe("JWT appId does not match route appId");
  });

  it("returns 400 for invalid teamId format", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/not-a-uuid`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid appId format", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/not-a-uuid/teams/${EXISTING_TEAM_ID}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${EXISTING_TEAM_ID}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns stripeCustomerId as null when not set", async () => {
    const teamWithoutStripe = {
      ...EXISTING_TEAM,
      id: uuidv4(),
      stripeCustomerId: null,
    };

    mockPrisma.team.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === teamWithoutStripe.id) {
        return Promise.resolve(teamWithoutStripe);
      }
      if (where.id === EXISTING_TEAM_ID) {
        return Promise.resolve(EXISTING_TEAM);
      }
      return Promise.resolve(null);
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${teamWithoutStripe.id}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.stripeCustomerId).toBeNull();
  });
});
