import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  createTestJwt,
  buildUsageReportingTestApp,
} from "./usage-reporting-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();
const TEST_TEAM_ID = uuidv4();
const BILLING_ENTITY_ID = uuidv4();
const OTHER_APP_ID = uuidv4();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    team: { findUnique: vi.fn() },
    billableLineItem: { findMany: vi.fn() },
    usageEvent: { findMany: vi.fn() },
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

function authHeaders(
  overrides: Record<string, unknown> = {},
): Record<string, string> {
  const jwt = createTestJwt(TEST_SECRET, TEST_KID, TEST_APP_ID, overrides);
  return { authorization: `Bearer ${jwt}` };
}

const FROM = "2024-01-01T00:00:00.000Z";
const TO = "2024-01-31T23:59:59.000Z";

describe("GET /v1/teams/:teamId/cogs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    setupMocks();
    app = buildUsageReportingTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("returns COGS-only line items aggregated by app and meter", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });

    const lineItems = [
      {
        id: uuidv4(),
        appId: TEST_APP_ID,
        usageEventId: "evt-1",
        amountMinor: 100,
        priceBook: { kind: "COGS" },
      },
      {
        id: uuidv4(),
        appId: TEST_APP_ID,
        usageEventId: "evt-2",
        amountMinor: 200,
        priceBook: { kind: "COGS" },
      },
    ];
    mockPrisma.billableLineItem.findMany.mockResolvedValue(lineItems);

    mockPrisma.usageEvent.findMany.mockResolvedValue([
      { id: "evt-1", eventType: "llm.tokens.v1" },
      { id: "evt-2", eventType: "llm.tokens.v1" },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/cogs?from=${FROM}&to=${TO}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].app).toBe(TEST_APP_ID);
    expect(body.groups[0].meter).toBe("llm.tokens.v1");
    expect(body.groups[0].amountMinor).toBe(300);
    expect(body.groups[0].count).toBe(2);
  });

  it("filters to COGS-only line items via priceBook filter", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.billableLineItem.findMany.mockResolvedValue([]);

    await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/cogs?from=${FROM}&to=${TO}`,
      headers: authHeaders(),
    });

    expect(mockPrisma.billableLineItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          priceBook: { kind: "COGS" },
        }),
      }),
    );
  });

  it("returns empty results for empty date range", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.billableLineItem.findMany.mockResolvedValue([]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/cogs?from=${FROM}&to=${TO}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups).toHaveLength(0);
  });

  it("returns 404 for nonexistent team", async () => {
    mockPrisma.team.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/cogs?from=${FROM}&to=${TO}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 403 when scopes are insufficient", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/cogs?from=${FROM}&to=${TO}`,
      headers: authHeaders({ scopes: ["usage:write"] }),
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 400 for missing required query params", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/cogs`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/cogs?from=${FROM}&to=${TO}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("aggregates multiple apps and meters separately", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });

    const lineItems = [
      {
        id: uuidv4(),
        appId: TEST_APP_ID,
        usageEventId: "evt-1",
        amountMinor: 100,
        priceBook: { kind: "COGS" },
      },
      {
        id: uuidv4(),
        appId: OTHER_APP_ID,
        usageEventId: "evt-2",
        amountMinor: 50,
        priceBook: { kind: "COGS" },
      },
      {
        id: uuidv4(),
        appId: TEST_APP_ID,
        usageEventId: "evt-3",
        amountMinor: 75,
        priceBook: { kind: "COGS" },
      },
    ];
    mockPrisma.billableLineItem.findMany.mockResolvedValue(lineItems);

    mockPrisma.usageEvent.findMany.mockResolvedValue([
      { id: "evt-1", eventType: "llm.tokens.v1" },
      { id: "evt-2", eventType: "llm.image.v1" },
      { id: "evt-3", eventType: "llm.image.v1" },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/cogs?from=${FROM}&to=${TO}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups).toHaveLength(3);

    const app1Tokens = body.groups.find(
      (g: { app: string; meter: string }) =>
        g.app === TEST_APP_ID && g.meter === "llm.tokens.v1",
    );
    expect(app1Tokens).toBeDefined();
    expect(app1Tokens.amountMinor).toBe(100);
    expect(app1Tokens.count).toBe(1);

    const app2Images = body.groups.find(
      (g: { app: string; meter: string }) =>
        g.app === OTHER_APP_ID && g.meter === "llm.image.v1",
    );
    expect(app2Images).toBeDefined();
    expect(app2Images.amountMinor).toBe(50);

    const app1Images = body.groups.find(
      (g: { app: string; meter: string }) =>
        g.app === TEST_APP_ID && g.meter === "llm.image.v1",
    );
    expect(app1Images).toBeDefined();
    expect(app1Images.amountMinor).toBe(75);
  });
});
