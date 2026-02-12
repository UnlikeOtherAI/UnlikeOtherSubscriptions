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

describe("GET /v1/teams/:teamId/usage", () => {
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

  it("returns usage grouped by app with correct totals", async () => {
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
        usageEventId: "evt-1",
        amountMinor: 200,
        priceBook: { kind: "CUSTOMER" },
      },
      {
        id: uuidv4(),
        appId: OTHER_APP_ID,
        usageEventId: "evt-2",
        amountMinor: 50,
        priceBook: { kind: "COGS" },
      },
    ];
    mockPrisma.billableLineItem.findMany.mockResolvedValue(lineItems);

    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/usage?from=${FROM}&to=${TO}&groupBy=app`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groupBy).toBe("app");
    expect(body.from).toBe(FROM);
    expect(body.to).toBe(TO);
    expect(body.groups).toHaveLength(2);

    const appGroup = body.groups.find(
      (g: { groupKey: string }) => g.groupKey === TEST_APP_ID,
    );
    expect(appGroup).toBeDefined();
    expect(appGroup.cogsAmountMinor).toBe(100);
    expect(appGroup.customerAmountMinor).toBe(200);
    expect(appGroup.count).toBe(2);

    const otherGroup = body.groups.find(
      (g: { groupKey: string }) => g.groupKey === OTHER_APP_ID,
    );
    expect(otherGroup).toBeDefined();
    expect(otherGroup.cogsAmountMinor).toBe(50);
    expect(otherGroup.customerAmountMinor).toBe(0);
    expect(otherGroup.count).toBe(1);
  });

  it("returns usage grouped by meter with correct totals", async () => {
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
        priceBook: { kind: "CUSTOMER" },
      },
      {
        id: uuidv4(),
        appId: TEST_APP_ID,
        usageEventId: "evt-2",
        amountMinor: 300,
        priceBook: { kind: "CUSTOMER" },
      },
    ];
    mockPrisma.billableLineItem.findMany.mockResolvedValue(lineItems);

    mockPrisma.usageEvent.findMany.mockResolvedValue([
      {
        id: "evt-1",
        eventType: "llm.tokens.v1",
        payload: { provider: "openai", model: "gpt-5" },
      },
      {
        id: "evt-2",
        eventType: "llm.image.v1",
        payload: { provider: "openai", model: "gpt-image-1" },
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/usage?from=${FROM}&to=${TO}&groupBy=meter`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups).toHaveLength(2);

    const tokensGroup = body.groups.find(
      (g: { groupKey: string }) => g.groupKey === "llm.tokens.v1",
    );
    expect(tokensGroup).toBeDefined();
    expect(tokensGroup.customerAmountMinor).toBe(100);

    const imageGroup = body.groups.find(
      (g: { groupKey: string }) => g.groupKey === "llm.image.v1",
    );
    expect(imageGroup).toBeDefined();
    expect(imageGroup.customerAmountMinor).toBe(300);
  });

  it("returns usage grouped by provider with correct totals", async () => {
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
      {
        id: "evt-1",
        eventType: "llm.tokens.v1",
        payload: { provider: "openai", model: "gpt-5" },
      },
      {
        id: "evt-2",
        eventType: "llm.tokens.v1",
        payload: { provider: "anthropic", model: "claude-3" },
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/usage?from=${FROM}&to=${TO}&groupBy=provider`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups).toHaveLength(2);

    const openaiGroup = body.groups.find(
      (g: { groupKey: string }) => g.groupKey === "openai",
    );
    expect(openaiGroup).toBeDefined();
    expect(openaiGroup.cogsAmountMinor).toBe(100);

    const anthropicGroup = body.groups.find(
      (g: { groupKey: string }) => g.groupKey === "anthropic",
    );
    expect(anthropicGroup).toBeDefined();
    expect(anthropicGroup.cogsAmountMinor).toBe(200);
  });

  it("returns empty results for empty date range", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.billableLineItem.findMany.mockResolvedValue([]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/usage?from=${FROM}&to=${TO}&groupBy=app`,
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
      url: `/v1/teams/${TEST_TEAM_ID}/usage?from=${FROM}&to=${TO}&groupBy=app`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 403 when scopes are insufficient", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/usage?from=${FROM}&to=${TO}&groupBy=app`,
      headers: authHeaders({ scopes: ["usage:write"] }),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toContain("billing:read");
  });

  it("returns 400 for missing required query params", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/usage`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid groupBy value", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/usage?from=${FROM}&to=${TO}&groupBy=invalid`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/usage?from=${FROM}&to=${TO}&groupBy=app`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("passes correct date range filter to Prisma", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });
    mockPrisma.billableLineItem.findMany.mockResolvedValue([]);

    await app.inject({
      method: "GET",
      url: `/v1/teams/${TEST_TEAM_ID}/usage?from=${FROM}&to=${TO}&groupBy=app`,
      headers: authHeaders(),
    });

    expect(mockPrisma.billableLineItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          billToId: BILLING_ENTITY_ID,
          timestamp: {
            gte: new Date(FROM),
            lte: new Date(TO),
          },
        }),
      }),
    );
  });
});
