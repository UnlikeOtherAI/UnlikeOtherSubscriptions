import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
  createTestTeam,
  createTestBillingEntity,
  randomSuffix,
} from "./test-db-helper.js";

let prisma: PrismaClient;

beforeAll(() => {
  prisma = getTestPrisma();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

async function createTestPriceBook(
  prisma: PrismaClient,
  appId: string,
  kind: "COGS" | "CUSTOMER" = "CUSTOMER",
) {
  return prisma.priceBook.create({
    data: {
      appId,
      kind,
      currency: "USD",
      effectiveFrom: new Date("2025-01-01T00:00:00Z"),
    },
  });
}

async function createTestPriceRule(
  prisma: PrismaClient,
  priceBookId: string,
) {
  return prisma.priceRule.create({
    data: {
      priceBookId,
      priority: 10,
      match: { eventType: "llm.tokens.v1" },
      rule: { type: "per_unit", field: "inputTokens", unitPrice: 0.001 },
    },
  });
}

describe("BillableLineItem integration", () => {
  it("creates a BillableLineItem with all required fields", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const priceBook = await createTestPriceBook(prisma, app.id);
    const priceRule = await createTestPriceRule(prisma, priceBook.id);

    const now = new Date();
    const item = await prisma.billableLineItem.create({
      data: {
        appId: app.id,
        billToId: be.id,
        teamId: team.id,
        timestamp: now,
        priceBookId: priceBook.id,
        priceRuleId: priceRule.id,
        amountMinor: 150,
        currency: "USD",
        description: "LLM token usage — 1500 input tokens",
        inputsSnapshot: {
          inputTokens: 1500,
          outputTokens: 0,
          unitPrice: 0.001,
        },
      },
    });

    expect(item.id).toBeDefined();
    expect(item.appId).toBe(app.id);
    expect(item.billToId).toBe(be.id);
    expect(item.teamId).toBe(team.id);
    expect(item.userId).toBeNull();
    expect(item.usageEventId).toBeNull();
    expect(item.timestamp).toEqual(now);
    expect(item.priceBookId).toBe(priceBook.id);
    expect(item.priceRuleId).toBe(priceRule.id);
    expect(item.amountMinor).toBe(150);
    expect(item.currency).toBe("USD");
    expect(item.description).toBe("LLM token usage — 1500 input tokens");
    expect(item.createdAt).toBeInstanceOf(Date);
  });

  it("stores and retrieves inputsSnapshot JSONB correctly", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const priceBook = await createTestPriceBook(prisma, app.id);
    const priceRule = await createTestPriceRule(prisma, priceBook.id);

    const snapshot = {
      provider: "openai",
      model: "gpt-5",
      inputTokens: 1200,
      outputTokens: 350,
      cachedTokens: 800,
      ruleType: "per_unit",
      unitPrice: 0.001,
      computedAmount: 155,
    };

    const item = await prisma.billableLineItem.create({
      data: {
        appId: app.id,
        billToId: be.id,
        teamId: team.id,
        timestamp: new Date(),
        priceBookId: priceBook.id,
        priceRuleId: priceRule.id,
        amountMinor: 155,
        currency: "USD",
        description: "LLM tokens",
        inputsSnapshot: snapshot,
      },
    });

    const fetched = await prisma.billableLineItem.findUnique({
      where: { id: item.id },
    });

    expect(fetched!.inputsSnapshot).toEqual(snapshot);
  });

  it("references both billToId (BillingEntity) and teamId", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const priceBook = await createTestPriceBook(prisma, app.id);
    const priceRule = await createTestPriceRule(prisma, priceBook.id);

    const item = await prisma.billableLineItem.create({
      data: {
        appId: app.id,
        billToId: be.id,
        teamId: team.id,
        timestamp: new Date(),
        priceBookId: priceBook.id,
        priceRuleId: priceRule.id,
        amountMinor: 100,
        currency: "USD",
        description: "Test",
        inputsSnapshot: {},
      },
    });

    const withRelations = await prisma.billableLineItem.findUnique({
      where: { id: item.id },
      include: { billingEntity: true, priceBook: true, priceRule: true },
    });

    expect(withRelations!.billingEntity.id).toBe(be.id);
    expect(withRelations!.priceBook.id).toBe(priceBook.id);
    expect(withRelations!.priceRule.id).toBe(priceRule.id);
  });

  it("enforces FK to BillingEntity — rejects invalid billToId", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const priceBook = await createTestPriceBook(prisma, app.id);
    const priceRule = await createTestPriceRule(prisma, priceBook.id);

    await expect(
      prisma.billableLineItem.create({
        data: {
          appId: app.id,
          billToId: "non-existent-be-id",
          teamId: team.id,
          timestamp: new Date(),
          priceBookId: priceBook.id,
          priceRuleId: priceRule.id,
          amountMinor: 100,
          currency: "USD",
          description: "Test",
          inputsSnapshot: {},
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to PriceBook — rejects invalid priceBookId", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const priceBook = await createTestPriceBook(prisma, app.id);
    const priceRule = await createTestPriceRule(prisma, priceBook.id);

    await expect(
      prisma.billableLineItem.create({
        data: {
          appId: app.id,
          billToId: be.id,
          teamId: team.id,
          timestamp: new Date(),
          priceBookId: "non-existent-pricebook-id",
          priceRuleId: priceRule.id,
          amountMinor: 100,
          currency: "USD",
          description: "Test",
          inputsSnapshot: {},
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to PriceRule — rejects invalid priceRuleId", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const priceBook = await createTestPriceBook(prisma, app.id);

    await expect(
      prisma.billableLineItem.create({
        data: {
          appId: app.id,
          billToId: be.id,
          teamId: team.id,
          timestamp: new Date(),
          priceBookId: priceBook.id,
          priceRuleId: "non-existent-rule-id",
          amountMinor: 100,
          currency: "USD",
          description: "Test",
          inputsSnapshot: {},
        },
      }),
    ).rejects.toThrow();
  });

  it("supports optional userId and usageEventId", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const priceBook = await createTestPriceBook(prisma, app.id);
    const priceRule = await createTestPriceRule(prisma, priceBook.id);

    const item = await prisma.billableLineItem.create({
      data: {
        appId: app.id,
        billToId: be.id,
        teamId: team.id,
        userId: "user-123",
        usageEventId: "event-456",
        timestamp: new Date(),
        priceBookId: priceBook.id,
        priceRuleId: priceRule.id,
        amountMinor: 200,
        currency: "USD",
        description: "With optional fields",
        inputsSnapshot: { test: true },
      },
    });

    expect(item.userId).toBe("user-123");
    expect(item.usageEventId).toBe("event-456");
  });

  it("queries by appId + teamId + timestamp index", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const priceBook = await createTestPriceBook(prisma, app.id);
    const priceRule = await createTestPriceRule(prisma, priceBook.id);

    const t1 = new Date("2025-03-01T00:00:00Z");
    const t2 = new Date("2025-03-15T00:00:00Z");
    const t3 = new Date("2025-04-01T00:00:00Z");

    for (const ts of [t1, t2, t3]) {
      await prisma.billableLineItem.create({
        data: {
          appId: app.id,
          billToId: be.id,
          teamId: team.id,
          timestamp: ts,
          priceBookId: priceBook.id,
          priceRuleId: priceRule.id,
          amountMinor: 100,
          currency: "USD",
          description: "Range test",
          inputsSnapshot: {},
        },
      });
    }

    const marchItems = await prisma.billableLineItem.findMany({
      where: {
        appId: app.id,
        teamId: team.id,
        timestamp: {
          gte: new Date("2025-03-01T00:00:00Z"),
          lt: new Date("2025-04-01T00:00:00Z"),
        },
      },
    });

    expect(marchItems).toHaveLength(2);
  });

  it("queries by billToId + timestamp index", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const priceBook = await createTestPriceBook(prisma, app.id);
    const priceRule = await createTestPriceRule(prisma, priceBook.id);

    await prisma.billableLineItem.create({
      data: {
        appId: app.id,
        billToId: be.id,
        teamId: team.id,
        timestamp: new Date("2025-06-01T00:00:00Z"),
        priceBookId: priceBook.id,
        priceRuleId: priceRule.id,
        amountMinor: 500,
        currency: "USD",
        description: "BillTo query test",
        inputsSnapshot: {},
      },
    });

    const items = await prisma.billableLineItem.findMany({
      where: {
        billToId: be.id,
        timestamp: { gte: new Date("2025-06-01T00:00:00Z") },
      },
    });

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].billToId).toBe(be.id);
  });
});
