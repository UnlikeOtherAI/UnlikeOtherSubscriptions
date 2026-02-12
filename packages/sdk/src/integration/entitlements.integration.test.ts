import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import {
  buildEntitlementTestApp,
} from "../../../../src/routes/entitlements-test-helpers.js";
import { createBillingClient } from "../client.js";
import { BillingApiError } from "../errors.js";
import {
  TEST_ENCRYPTION_KEY,
  TEST_SECRET,
  TEST_KID,
  TEST_APP_ID,
  TEST_TEAM_ID,
  startApp,
} from "./harness.js";

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

vi.mock("../../../../src/lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../../../../src/lib/pg-boss.js", () => ({ stopBoss: vi.fn() }));

vi.mock("../../../../src/lib/crypto.js", () => ({
  encryptSecret: (s: string) => `encrypted:${s}`,
  decryptSecret: (s: string) => s.replace("encrypted:", ""),
}));

function setupMocks(): void {
  mockPrisma.contract.findFirst.mockResolvedValue(null);

  mockPrisma.app.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === TEST_APP_ID) {
        return Promise.resolve({ id: TEST_APP_ID, name: "Test App", status: "ACTIVE" });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.appSecret.findUnique.mockImplementation(
    ({ where }: { where: { kid: string } }) => {
      if (where.kid === TEST_KID) {
        return Promise.resolve({
          id: uuidv4(), appId: TEST_APP_ID, kid: TEST_KID,
          secretHash: `encrypted:${TEST_SECRET}`, status: "ACTIVE",
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.jtiUsage.create.mockResolvedValue({});
}

describe("SDK → Entitlements (real Fastify stack)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let closeApp: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    setupMocks();
    app = buildEntitlementTestApp();
    const started = await startApp(app);
    baseUrl = started.baseUrl;
    closeApp = started.close;
  });

  afterEach(async () => {
    await closeApp();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("retrieves entitlements for a team with an active subscription", async () => {
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
        id: PLAN_ID, appId: TEST_APP_ID,
        code: "pro", name: "Pro Plan", status: "ACTIVE",
      },
    });

    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    const result = await client.getEntitlements(TEST_TEAM_ID);
    expect(result.billingMode).toBe("SUBSCRIPTION");
  });

  it("returns default entitlements when no subscription exists", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingMode: "SUBSCRIPTION",
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    const result = await client.getEntitlements(TEST_TEAM_ID);
    expect(result.billingMode).toBe("SUBSCRIPTION");
  });

  it("throws BillingApiError with 404 for nonexistent team", async () => {
    mockPrisma.team.findUnique.mockResolvedValue(null);

    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    try {
      await client.getEntitlements(TEST_TEAM_ID);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingApiError);
      expect((err as BillingApiError).statusCode).toBe(404);
    }
  });

  it("reflects team billingMode in response", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingMode: "WALLET",
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    const result = await client.getEntitlements(TEST_TEAM_ID);
    expect(result.billingMode).toBe("WALLET");
  });
});
