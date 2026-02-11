import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { createTestJwt, buildPortalTestApp } from "./portal-test-helpers.js";

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
  stripeCustomerId: "cus_existing123",
  billingMode: "SUBSCRIPTION",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPortalSessionCreate = vi.fn();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    team: { findUnique: vi.fn() },
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
    billingPortal: { sessions: { create: mockPortalSessionCreate } },
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

  // Team lookup
  mockPrisma.team.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === TEST_TEAM_ID) {
        return Promise.resolve({ ...TEST_TEAM });
      }
      return Promise.resolve(null);
    },
  );

  // Stripe billingPortal.sessions.create
  mockPortalSessionCreate.mockResolvedValue({
    id: "bps_test_session123",
    url: "https://billing.stripe.com/p/session/test_session123",
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

const PORTAL_URL = `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/portal`;

const VALID_PAYLOAD = {
  returnUrl: "https://example.com/settings",
};

describe("POST /v1/apps/:appId/teams/:teamId/portal", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";

    setupMocks();

    app = buildPortalTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("returns a valid portal session URL for a team with a Stripe customer", async () => {
    const response = await app.inject({
      method: "POST",
      url: PORTAL_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.url).toBe(
      "https://billing.stripe.com/p/session/test_session123",
    );
  });

  it("calls Stripe with the correct customer ID and return URL", async () => {
    await app.inject({
      method: "POST",
      url: PORTAL_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(mockPortalSessionCreate).toHaveBeenCalledOnce();
    expect(mockPortalSessionCreate).toHaveBeenCalledWith({
      customer: "cus_existing123",
      return_url: "https://example.com/settings",
    });
  });

  it("returns 400 for a team without a Stripe customer", async () => {
    mockPrisma.team.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === TEST_TEAM_ID) {
          return Promise.resolve({
            ...TEST_TEAM,
            stripeCustomerId: null,
          });
        }
        return Promise.resolve(null);
      },
    );

    const response = await app.inject({
      method: "POST",
      url: PORTAL_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.message).toBe("Team has no Stripe customer");
  });

  it("returns 400 for a team with a pending Stripe customer claim", async () => {
    mockPrisma.team.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === TEST_TEAM_ID) {
          return Promise.resolve({
            ...TEST_TEAM,
            stripeCustomerId: `pending:${TEST_TEAM_ID}`,
          });
        }
        return Promise.resolve(null);
      },
    );

    const response = await app.inject({
      method: "POST",
      url: PORTAL_URL,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.message).toBe("Team has no Stripe customer");
  });

  it("returns 404 for a nonexistent team", async () => {
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
      url: `/v1/apps/${TEST_APP_ID}/teams/${nonexistentTeamId}/portal`,
      payload: VALID_PAYLOAD,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("Team not found");
  });

  it("validates that the team belongs to the requesting App (JWT appId mismatch)", async () => {
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${differentAppId}/teams/${TEST_TEAM_ID}/portal`,
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
      url: PORTAL_URL,
      payload: VALID_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for missing returnUrl", async () => {
    const response = await app.inject({
      method: "POST",
      url: PORTAL_URL,
      payload: {},
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid returnUrl", async () => {
    const response = await app.inject({
      method: "POST",
      url: PORTAL_URL,
      payload: { returnUrl: "not-a-url" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });
});
