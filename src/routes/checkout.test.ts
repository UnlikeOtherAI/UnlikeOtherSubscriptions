import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { createTestJwt, buildCheckoutTestApp } from "./checkout-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();
const TEST_TEAM_ID = uuidv4();
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
      id: uuidv4(),
      appId: TEST_APP_ID,
      planId: TEST_PLAN_ID,
      stripeProductId: "prod_base123",
      stripePriceId: "price_base123",
      kind: "BASE",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: uuidv4(),
      appId: TEST_APP_ID,
      planId: TEST_PLAN_ID,
      stripeProductId: "prod_seat123",
      stripePriceId: "price_seat123",
      kind: "SEAT",
      createdAt: new Date(),
      updatedAt: new Date(),
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

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/pg-boss.js", () => ({ stopBoss: vi.fn() }));

vi.mock("../lib/crypto.js", () => ({
  encryptSecret: (s: string) => `encrypted:${s}`,
  decryptSecret: (s: string) => s.replace("encrypted:", ""),
}));

vi.mock("../lib/stripe.js", () => ({
  getStripeClient: () => ({
    customers: { create: mockCustomersCreate },
    checkout: { sessions: { create: mockCheckoutSessionCreate } },
  }),
  resetStripeClient: vi.fn(),
}));

function setupMocks(): void {
  // AppSecret lookup for JWT auth
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

  // JTI usage for replay protection
  mockPrisma.jtiUsage.create.mockResolvedValue({});

  // Plan lookup
  mockPrisma.plan.findUnique.mockImplementation(
    ({
      where,
    }: {
      where: { appId_code: { appId: string; code: string } };
    }) => {
      if (
        where.appId_code.appId === TEST_APP_ID &&
        where.appId_code.code === "pro-monthly"
      ) {
        return Promise.resolve(TEST_PLAN);
      }
      return Promise.resolve(null);
    },
  );

  // Team lookup for StripeService.getOrCreateStripeCustomer
  let teamStripeCustomerId: string | null = null;
  mockPrisma.team.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === TEST_TEAM_ID) {
        return Promise.resolve({
          ...TEST_TEAM,
          stripeCustomerId: teamStripeCustomerId,
        });
      }
      return Promise.resolve(null);
    },
  );

  // Team updateMany for claim
  mockPrisma.team.updateMany.mockImplementation(
    async (args: {
      where: { stripeCustomerId: unknown };
      data: { stripeCustomerId: string | null };
    }) => {
      if (args.where.stripeCustomerId === null) {
        teamStripeCustomerId = args.data.stripeCustomerId;
        return { count: 1 };
      }
      return { count: 0 };
    },
  );

  // Team update for storing real customer ID
  mockPrisma.team.update.mockImplementation(
    async (args: { data: { stripeCustomerId: string } }) => {
      teamStripeCustomerId = args.data.stripeCustomerId;
      return { ...TEST_TEAM, stripeCustomerId: args.data.stripeCustomerId };
    },
  );

  // Stripe customers.create
  mockCustomersCreate.mockResolvedValue({
    id: "cus_test_new",
    object: "customer",
    name: TEST_TEAM.name,
    metadata: { teamId: TEST_TEAM_ID, appId: TEST_APP_ID },
  });

  // Stripe checkout.sessions.create
  mockCheckoutSessionCreate.mockResolvedValue({
    id: "cs_test_session123",
    url: "https://checkout.stripe.com/c/pay/cs_test_session123",
  });
}

function authHeaders(appIdOverride?: string): Record<string, string> {
  const jwt = createTestJwt(
    TEST_SECRET,
    TEST_KID,
    appIdOverride ?? TEST_APP_ID,
  );
  return { authorization: `Bearer ${jwt}` };
}

const CHECKOUT_URL = `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/checkout/subscription`;

const VALID_PAYLOAD = {
  planCode: "pro-monthly",
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
};

describe("POST /v1/apps/:appId/teams/:teamId/checkout/subscription", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";

    setupMocks();

    app = buildCheckoutTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("returns a valid Checkout Session URL and sessionId", async () => {
    const response = await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.url).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_session123",
    );
    expect(body.sessionId).toBe("cs_test_session123");
  });

  it("uses the correct Stripe price IDs from StripeProductMap", async () => {
    await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(mockCheckoutSessionCreate).toHaveBeenCalledOnce();
    const createArgs = mockCheckoutSessionCreate.mock.calls[0][0];
    expect(createArgs.mode).toBe("subscription");
    expect(createArgs.line_items).toEqual(
      expect.arrayContaining([
        { price: "price_base123", quantity: 1 },
        { price: "price_seat123", quantity: 1 },
      ]),
    );
  });

  it("creates a Stripe customer if one does not exist", async () => {
    await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_test_new",
      }),
    );
  });

  it("uses existing Stripe customer if team already has one", async () => {
    // Override team to already have a Stripe customer ID
    mockPrisma.team.findUnique.mockResolvedValue({
      ...TEST_TEAM,
      stripeCustomerId: "cus_existing456",
    });

    await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_existing456",
      }),
    );
  });

  it("rejects planCode not belonging to the App (404)", async () => {
    const response = await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: {
        ...VALID_PAYLOAD,
        planCode: "nonexistent-plan",
      },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("Plan not found");
  });

  it("rejects requests for teams that do not exist (404)", async () => {
    const nonexistentTeamId = uuidv4();
    // Plan lookup will succeed, but team lookup will return null for the nonexistent team
    mockPrisma.team.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === nonexistentTeamId) {
          return Promise.resolve(null);
        }
        return Promise.resolve(TEST_TEAM);
      },
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${nonexistentTeamId}/checkout/subscription`,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("Team not found");
  });

  it("passes seat quantity correctly to Stripe line items", async () => {
    const response = await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: { ...VALID_PAYLOAD, seats: 5 },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(mockCheckoutSessionCreate).toHaveBeenCalledOnce();
    const createArgs = mockCheckoutSessionCreate.mock.calls[0][0];
    const seatItem = createArgs.line_items.find(
      (item: { price: string }) => item.price === "price_seat123",
    );
    expect(seatItem).toEqual({ price: "price_seat123", quantity: 5 });
  });

  it("defaults seat quantity to 1 when seats not provided", async () => {
    await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    const createArgs = mockCheckoutSessionCreate.mock.calls[0][0];
    const seatItem = createArgs.line_items.find(
      (item: { price: string }) => item.price === "price_seat123",
    );
    expect(seatItem.quantity).toBe(1);
  });

  it("returns 403 when JWT appId does not match route appId", async () => {
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${differentAppId}/teams/${TEST_TEAM_ID}/checkout/subscription`,
      payload: VALID_PAYLOAD,
      headers: authHeaders(), // JWT has TEST_APP_ID
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toBe("JWT appId does not match route appId");
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: VALID_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for missing planCode", async () => {
    const response = await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: {
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid successUrl", async () => {
    const response = await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: {
        planCode: "pro-monthly",
        successUrl: "not-a-url",
        cancelUrl: "https://example.com/cancel",
      },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid seats (non-positive)", async () => {
    const response = await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: { ...VALID_PAYLOAD, seats: 0 },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("passes metadata to the Stripe Checkout Session", async () => {
    await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    const createArgs = mockCheckoutSessionCreate.mock.calls[0][0];
    expect(createArgs.metadata).toEqual({
      teamId: TEST_TEAM_ID,
      appId: TEST_APP_ID,
      planId: TEST_PLAN_ID,
    });
  });

  it("passes success_url and cancel_url to Stripe", async () => {
    await app.inject({
      method: "POST",
      url: CHECKOUT_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    const createArgs = mockCheckoutSessionCreate.mock.calls[0][0];
    expect(createArgs.success_url).toBe("https://example.com/success");
    expect(createArgs.cancel_url).toBe("https://example.com/cancel");
  });
});
