import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { createTestJwt, buildTopupTestApp } from "./topup-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();
const TEST_TEAM_ID = uuidv4();

const TEST_TEAM = {
  id: TEST_TEAM_ID,
  name: "Test Team",
  kind: "STANDARD",
  ownerUserId: null,
  defaultCurrency: "USD",
  stripeCustomerId: null as string | null,
  billingMode: "WALLET",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockCheckoutSessionCreate = vi.fn();
const mockCustomersCreate = vi.fn();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
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

  mockPrisma.team.update.mockImplementation(
    async (args: { data: { stripeCustomerId: string } }) => {
      teamStripeCustomerId = args.data.stripeCustomerId;
      return { ...TEST_TEAM, stripeCustomerId: args.data.stripeCustomerId };
    },
  );

  mockCustomersCreate.mockResolvedValue({
    id: "cus_test_new",
    object: "customer",
    name: TEST_TEAM.name,
    metadata: { teamId: TEST_TEAM_ID, appId: TEST_APP_ID },
  });

  mockCheckoutSessionCreate.mockResolvedValue({
    id: "cs_test_topup_session",
    url: "https://checkout.stripe.com/c/pay/cs_test_topup_session",
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

const TOPUP_URL = `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/checkout/topup`;

const VALID_PAYLOAD = {
  amountMinor: 5000,
  currency: "usd",
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
};

describe("POST /v1/apps/:appId/teams/:teamId/checkout/topup", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";

    setupMocks();

    app = buildTopupTestApp();
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
      url: TOPUP_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.url).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_topup_session",
    );
    expect(body.sessionId).toBe("cs_test_topup_session");
  });

  it("creates a Stripe Checkout Session in payment mode", async () => {
    await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(mockCheckoutSessionCreate).toHaveBeenCalledOnce();
    const args = mockCheckoutSessionCreate.mock.calls[0][0];
    expect(args.mode).toBe("payment");
  });

  it("passes correct amount and currency to Stripe line items", async () => {
    await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    const args = mockCheckoutSessionCreate.mock.calls[0][0];
    expect(args.line_items).toEqual([
      {
        price_data: {
          currency: "usd",
          unit_amount: 5000,
          product_data: { name: "Wallet Top-Up" },
        },
        quantity: 1,
      },
    ]);
  });

  it("creates a Stripe customer if one does not exist", async () => {
    await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_test_new" }),
    );
  });

  it("uses existing Stripe customer if team already has one", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      ...TEST_TEAM,
      stripeCustomerId: "cus_existing456",
    });

    await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing456" }),
    );
  });

  it("includes wallet_topup metadata in the Stripe session", async () => {
    await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    const args = mockCheckoutSessionCreate.mock.calls[0][0];
    expect(args.metadata).toEqual({
      teamId: TEST_TEAM_ID,
      appId: TEST_APP_ID,
      type: "wallet_topup",
      amountMinor: "5000",
    });
  });

  it("sets payment_intent_data.metadata so payment_intent.succeeded can process top-ups", async () => {
    await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    const args = mockCheckoutSessionCreate.mock.calls[0][0];
    expect(args.payment_intent_data).toBeDefined();
    expect(args.payment_intent_data.metadata).toEqual({
      teamId: TEST_TEAM_ID,
      appId: TEST_APP_ID,
      type: "wallet_topup",
      amountMinor: "5000",
    });
  });

  it("rejects requests for teams that do not exist (404)", async () => {
    const nonexistentTeamId = uuidv4();
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
      url: `/v1/apps/${TEST_APP_ID}/teams/${nonexistentTeamId}/checkout/topup`,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe("Team not found");
  });

  it("returns 403 when JWT appId does not match route appId", async () => {
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${differentAppId}/teams/${TEST_TEAM_ID}/checkout/topup`,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe(
      "JWT appId does not match route appId",
    );
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: VALID_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for missing amountMinor", async () => {
    const response = await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: {
        currency: "usd",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for zero amountMinor", async () => {
    const response = await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: { ...VALID_PAYLOAD, amountMinor: 0 },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid successUrl", async () => {
    const response = await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: { ...VALID_PAYLOAD, successUrl: "not-a-url" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("passes success_url and cancel_url to Stripe", async () => {
    await app.inject({
      method: "POST",
      url: TOPUP_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    const args = mockCheckoutSessionCreate.mock.calls[0][0];
    expect(args.success_url).toBe("https://example.com/success");
    expect(args.cancel_url).toBe("https://example.com/cancel");
  });
});
