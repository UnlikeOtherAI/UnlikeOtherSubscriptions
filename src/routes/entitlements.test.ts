import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  createTestJwt,
  buildEntitlementTestApp,
} from "./entitlements-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();
const TEST_TEAM_ID = uuidv4();
const PLAN_ID = uuidv4();
const BILLING_ENTITY_ID = uuidv4();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    teamSubscription: { findFirst: vi.fn() },
    contract: { findFirst: vi.fn() },
    appSecret: { findUnique: vi.fn() },
    jtiUsage: { create: vi.fn() },
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
  // Default: no active enterprise contract
  mockPrisma.contract.findFirst.mockResolvedValue(null);

  mockPrisma.app.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === TEST_APP_ID) {
        return Promise.resolve({
          id: TEST_APP_ID,
          name: "Test App",
          status: "ACTIVE",
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.appSecret.findUnique.mockImplementation(
    ({ where }: { where: { kid: string } }) => {
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
    },
  );

  mockPrisma.jtiUsage.create.mockResolvedValue({});
}

function authHeaders(appIdOverride?: string): Record<string, string> {
  const jwt = createTestJwt(
    TEST_SECRET,
    TEST_KID,
    appIdOverride ?? TEST_APP_ID,
  );
  return { authorization: `Bearer ${jwt}` };
}

describe("GET /v1/apps/:appId/teams/:teamId/entitlements", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    setupMocks();

    app = buildEntitlementTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("returns plan entitlements for team with active subscription", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingMode: "SUBSCRIPTION",
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.teamSubscription.findFirst.mockResolvedValue({
      id: uuidv4(),
      teamId: TEST_TEAM_ID,
      status: "ACTIVE",
      planId: PLAN_ID,
      plan: {
        id: PLAN_ID,
        appId: TEST_APP_ID,
        code: "pro",
        name: "Pro Plan",
        status: "ACTIVE",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/entitlements`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.billingMode).toBe("SUBSCRIPTION");
    expect(body.billable).toBe(true);
    expect(body.planCode).toBe("pro");
    expect(body.planName).toBe("Pro Plan");
    expect(body.features).toEqual({});
    expect(body.meters).toEqual({});
  });

  it("returns default entitlements for team with no subscription", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingMode: "SUBSCRIPTION",
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/entitlements`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.billingMode).toBe("SUBSCRIPTION");
    expect(body.billable).toBe(false);
    expect(body.planCode).toBeNull();
    expect(body.planName).toBeNull();
  });

  it("returns default entitlements for team with cancelled subscription", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingMode: "SUBSCRIPTION",
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/entitlements`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.billable).toBe(false);
    expect(body.planCode).toBeNull();
  });

  it("reflects team billingMode in response", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingMode: "WALLET",
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/entitlements`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.billingMode).toBe("WALLET");
  });

  it("returns 404 for nonexistent team", async () => {
    mockPrisma.team.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/entitlements`,
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
      url: `/v1/apps/${differentAppId}/teams/${TEST_TEAM_ID}/entitlements`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toBe("JWT appId does not match route appId");
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/entitlements`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for invalid teamId format", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/not-a-uuid/entitlements`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid appId format", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/not-a-uuid/teams/${TEST_TEAM_ID}/entitlements`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });
});
