import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
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

describe("PriceRule integration", () => {
  it("creates a PriceRule linked to a PriceBook", async () => {
    const app = await createTestApp(prisma);
    const priceBook = await createTestPriceBook(prisma, app.id);

    const rule = await prisma.priceRule.create({
      data: {
        priceBookId: priceBook.id,
        priority: 10,
        match: { eventType: "llm.tokens.v1", provider: "openai" },
        rule: { type: "per_unit", field: "inputTokens", unitPrice: 0.001 },
      },
    });

    expect(rule.id).toBeDefined();
    expect(rule.priceBookId).toBe(priceBook.id);
    expect(rule.priority).toBe(10);
    expect(rule.match).toEqual({
      eventType: "llm.tokens.v1",
      provider: "openai",
    });
    expect(rule.rule).toEqual({
      type: "per_unit",
      field: "inputTokens",
      unitPrice: 0.001,
    });
    expect(rule.createdAt).toBeInstanceOf(Date);
  });

  it("enforces FK to PriceBook — rejects invalid priceBookId", async () => {
    await expect(
      prisma.priceRule.create({
        data: {
          priceBookId: "non-existent-pricebook-id",
          priority: 1,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 100 },
        },
      }),
    ).rejects.toThrow();
  });

  it("stores complex JSONB match and rule fields", async () => {
    const app = await createTestApp(prisma);
    const priceBook = await createTestPriceBook(prisma, app.id);

    const complexMatch = {
      eventType: "llm.image.v1",
      provider: "openai",
      model: "gpt-image-1",
    };
    const complexRule = {
      type: "formula",
      formula: "ceil((width*height)/1000000) * rate_per_mp",
      params: { rate_per_mp: 0.02 },
    };

    const rule = await prisma.priceRule.create({
      data: {
        priceBookId: priceBook.id,
        priority: 5,
        match: complexMatch,
        rule: complexRule,
      },
    });

    const fetched = await prisma.priceRule.findUnique({
      where: { id: rule.id },
    });

    expect(fetched!.match).toEqual(complexMatch);
    expect(fetched!.rule).toEqual(complexRule);
  });

  it("allows multiple rules on the same PriceBook with different priorities", async () => {
    const app = await createTestApp(prisma);
    const priceBook = await createTestPriceBook(prisma, app.id);

    const rule1 = await prisma.priceRule.create({
      data: {
        priceBookId: priceBook.id,
        priority: 10,
        match: { eventType: "llm.tokens.v1" },
        rule: { type: "per_unit", field: "inputTokens", unitPrice: 0.001 },
      },
    });

    const rule2 = await prisma.priceRule.create({
      data: {
        priceBookId: priceBook.id,
        priority: 20,
        match: { eventType: "llm.tokens.v1", model: "gpt-5" },
        rule: { type: "per_unit", field: "inputTokens", unitPrice: 0.002 },
      },
    });

    const rules = await prisma.priceRule.findMany({
      where: { priceBookId: priceBook.id },
      orderBy: { priority: "desc" },
    });

    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe(rule2.id);
    expect(rules[0].priority).toBe(20);
    expect(rules[1].id).toBe(rule1.id);
    expect(rules[1].priority).toBe(10);
  });

  it("includes priceBook via PriceRule.include", async () => {
    const app = await createTestApp(prisma);
    const priceBook = await createTestPriceBook(prisma, app.id);

    const rule = await prisma.priceRule.create({
      data: {
        priceBookId: priceBook.id,
        priority: 1,
        match: { eventType: "storage.sample.v1" },
        rule: { type: "flat", amount: 500 },
      },
    });

    const result = await prisma.priceRule.findUnique({
      where: { id: rule.id },
      include: { priceBook: true },
    });

    expect(result!.priceBook.id).toBe(priceBook.id);
    expect(result!.priceBook.kind).toBe("CUSTOMER");
  });
});
