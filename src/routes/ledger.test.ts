import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { createTestJwt, buildLedgerTestApp } from "./ledger-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();
const TEST_TEAM_ID = uuidv4();
const BILLING_ENTITY_ID = uuidv4();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    team: { findUnique: vi.fn() },
    ledgerAccount: { findUnique: vi.fn() },
    ledgerEntry: { findMany: vi.fn(), count: vi.fn() },
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

describe("GET /v1/apps/:appId/teams/:teamId/ledger", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    setupMocks();

    app = buildLedgerTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("returns paginated ledger entries for a team", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });

    const mockEntries = [
      {
        id: uuidv4(),
        appId: TEST_APP_ID,
        billToId: BILLING_ENTITY_ID,
        ledgerAccountId: uuidv4(),
        timestamp: new Date().toISOString(),
        type: "TOPUP",
        amountMinor: 10000,
        currency: "usd",
        referenceType: "STRIPE_PAYMENT_INTENT",
        referenceId: "pi_123",
        idempotencyKey: "key-1",
        metadata: null,
        createdAt: new Date().toISOString(),
      },
    ];
    mockPrisma.ledgerEntry.findMany.mockResolvedValue(mockEntries);
    mockPrisma.ledgerEntry.count.mockResolvedValue(1);

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/ledger`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.entries[0].type).toBe("TOPUP");
    expect(body.entries[0].amountMinor).toBe(10000);
  });

  it("returns filtered entries by date range", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
    mockPrisma.ledgerEntry.count.mockResolvedValue(0);

    const from = "2024-01-01T00:00:00.000Z";
    const to = "2024-01-31T23:59:59.000Z";

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/ledger?from=${from}&to=${to}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries).toHaveLength(0);
    expect(body.total).toBe(0);

    expect(mockPrisma.ledgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appId: TEST_APP_ID,
          billToId: BILLING_ENTITY_ID,
          timestamp: {
            gte: new Date(from),
            lte: new Date(to),
          },
        }),
      }),
    );
  });

  it("returns filtered entries by type", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
    mockPrisma.ledgerEntry.count.mockResolvedValue(0);

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/ledger?type=SUBSCRIPTION_CHARGE`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.ledgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: "SUBSCRIPTION_CHARGE",
        }),
      }),
    );
  });

  it("returns 404 for nonexistent team", async () => {
    mockPrisma.team.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/ledger`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for team without billing entity", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: null,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/ledger`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 403 when JWT appId does not match route appId", async () => {
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${differentAppId}/teams/${TEST_TEAM_ID}/ledger`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/ledger`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for invalid appId format", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/not-a-uuid/teams/${TEST_TEAM_ID}/ledger`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid teamId format", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/not-a-uuid/ledger`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("applies pagination with limit and offset", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
    mockPrisma.ledgerEntry.count.mockResolvedValue(100);

    const response = await app.inject({
      method: "GET",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/ledger?limit=20&offset=40`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(40);
    expect(body.total).toBe(100);

    expect(mockPrisma.ledgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        skip: 40,
      }),
    );
  });
});
