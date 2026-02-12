import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import {
  buildCheckoutTestApp,
} from "../../../../src/routes/checkout-test-helpers.js";
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

const TEST_PLAN_ID = uuidv4();

const TEST_PLAN = {
  id: TEST_PLAN_ID,
  appId: TEST_APP_ID,
  code: "pro-monthly",
  name: "Pro Monthly",
  status: "ACTIVE",
  createdAt: new Date(),
  updatedAt: new Date(),
  stripeProductMaps: [
    {
      id: uuidv4(), appId: TEST_APP_ID, planId: TEST_PLAN_ID,
      stripeProductId: "prod_base123", stripePriceId: "price_base123",
      kind: "BASE", createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: uuidv4(), appId: TEST_APP_ID, planId: TEST_PLAN_ID,
      stripeProductId: "prod_seat123", stripePriceId: "price_seat123",
      kind: "SEAT", createdAt: new Date(), updatedAt: new Date(),
    },
  ],
};

const TEST_TEAM = {
  id: TEST_TEAM_ID,
  name: "Test Team",
  kind: "STANDARD",
  ownerUserId: null,
  defaultCurrency: "USD",
  stripeCustomerId: null as string | null,
  billingMode: "SUBSCRIPTION",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockCheckoutSessionCreate = vi.fn();
const mockCustomersCreate = vi.fn();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plan: { findUnique: vi.fn() },
    team: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
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

vi.mock("../../../../src/lib/stripe.js", () => ({
  getStripeClient: () => ({
    customers: { create: mockCustomersCreate },
    checkout: { sessions: { create: mockCheckoutSessionCreate } },
  }),
  resetStripeClient: vi.fn(),
}));

function setupMocks(): void {
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

  mockPrisma.plan.findUnique.mockImplementation(
    ({ where }: { where: { appId_code: { appId: string; code: string } } }) => {
      if (where.appId_code.appId === TEST_APP_ID && where.appId_code.code === "pro-monthly") {
        return Promise.resolve(TEST_PLAN);
      }
      return Promise.resolve(null);
    },
  );

  let teamStripeCustomerId: string | null = null;
  mockPrisma.team.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === TEST_TEAM_ID) {
        return Promise.resolve({ ...TEST_TEAM, stripeCustomerId: teamStripeCustomerId });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.team.updateMany.mockImplementation(
    async (args: { where: { stripeCustomerId: unknown }; data: { stripeCustomerId: string | null } }) => {
      if (args.where.stripeCustomerId === null) {
        teamStripeCustomerId = args.data.stripeCustomerId;
        return { count: 1 };
      }
      return { count: 0 };
    },
  );

  mockPrisma.team.update.mockImplementation(
    async (args: { data: { stripeCustomerId: string } }) => {
      teamStripeCustomerId = args.data.stripeCustomerId;
      return { ...TEST_TEAM, stripeCustomerId: args.data.stripeCustomerId };
    },
  );

  mockCustomersCreate.mockResolvedValue({
    id: "cus_test_new", object: "customer",
    name: TEST_TEAM.name, metadata: { teamId: TEST_TEAM_ID, appId: TEST_APP_ID },
  });

  mockCheckoutSessionCreate.mockResolvedValue({
    id: "cs_test_session123",
    url: "https://checkout.stripe.com/c/pay/cs_test_session123",
  });
}

describe("SDK → Checkout (real Fastify stack)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let closeApp: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    setupMocks();
    app = buildCheckoutTestApp();
    const started = await startApp(app);
    baseUrl = started.baseUrl;
    closeApp = started.close;
  });

  afterEach(async () => {
    await closeApp();
    delete process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("creates a checkout session and returns url + sessionId", async () => {
    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    const result = await client.createCheckout(TEST_TEAM_ID, {
      planCode: "pro-monthly",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(result.url).toBe("https://checkout.stripe.com/c/pay/cs_test_session123");
    expect(result.sessionId).toBe("cs_test_session123");
  });

  it("returns url when server omits sessionId", async () => {
    mockCheckoutSessionCreate.mockResolvedValueOnce({
      id: undefined,
      url: "https://checkout.stripe.com/c/pay/minimal",
    });

    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    const result = await client.createCheckout(TEST_TEAM_ID, {
      planCode: "pro-monthly",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(result.url).toBe("https://checkout.stripe.com/c/pay/minimal");
  });

  it("throws BillingApiError with 404 for nonexistent plan", async () => {
    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    try {
      await client.createCheckout(TEST_TEAM_ID, {
        planCode: "nonexistent-plan",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingApiError);
      expect((err as BillingApiError).statusCode).toBe(404);
    }
  });

  it("throws BillingApiError with 404 for nonexistent team", async () => {
    const nonexistentTeamId = uuidv4();
    mockPrisma.team.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === nonexistentTeamId) return Promise.resolve(null);
        return Promise.resolve(TEST_TEAM);
      },
    );

    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    try {
      await client.createCheckout(nonexistentTeamId, {
        planCode: "pro-monthly",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingApiError);
      expect((err as BillingApiError).statusCode).toBe(404);
    }
  });

  it("passes seat quantity to Stripe checkout", async () => {
    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    await client.createCheckout(TEST_TEAM_ID, {
      planCode: "pro-monthly",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      seats: 5,
    });

    const createArgs = mockCheckoutSessionCreate.mock.calls[0][0];
    const seatItem = createArgs.line_items.find(
      (item: { price: string }) => item.price === "price_seat123",
    );
    expect(seatItem.quantity).toBe(5);
  });
});
