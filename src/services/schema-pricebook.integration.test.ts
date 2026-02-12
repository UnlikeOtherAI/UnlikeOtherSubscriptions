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

describe("PriceBook integration", () => {
  it("creates a COGS PriceBook with correct fields", async () => {
    const app = await createTestApp(prisma);

    const priceBook = await prisma.priceBook.create({
      data: {
        appId: app.id,
        kind: "COGS",
        currency: "USD",
        version: 1,
        effectiveFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });

    expect(priceBook.id).toBeDefined();
    expect(priceBook.appId).toBe(app.id);
    expect(priceBook.kind).toBe("COGS");
    expect(priceBook.currency).toBe("USD");
    expect(priceBook.version).toBe(1);
    expect(priceBook.effectiveFrom).toEqual(new Date("2025-01-01T00:00:00Z"));
    expect(priceBook.effectiveTo).toBeNull();
    expect(priceBook.createdAt).toBeInstanceOf(Date);
    expect(priceBook.updatedAt).toBeInstanceOf(Date);
  });

  it("creates a CUSTOMER PriceBook with effectiveTo", async () => {
    const app = await createTestApp(prisma);

    const priceBook = await prisma.priceBook.create({
      data: {
        appId: app.id,
        kind: "CUSTOMER",
        currency: "GBP",
        version: 2,
        effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        effectiveTo: new Date("2025-12-31T23:59:59Z"),
      },
    });

    expect(priceBook.kind).toBe("CUSTOMER");
    expect(priceBook.currency).toBe("GBP");
    expect(priceBook.version).toBe(2);
    expect(priceBook.effectiveTo).toEqual(
      new Date("2025-12-31T23:59:59Z"),
    );
  });

  it("enforces FK to App — rejects invalid appId", async () => {
    await expect(
      prisma.priceBook.create({
        data: {
          appId: "non-existent-app-id",
          kind: "COGS",
          currency: "USD",
          effectiveFrom: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("defaults version to 1", async () => {
    const app = await createTestApp(prisma);

    const priceBook = await prisma.priceBook.create({
      data: {
        appId: app.id,
        kind: "COGS",
        currency: "USD",
        effectiveFrom: new Date(),
      },
    });

    expect(priceBook.version).toBe(1);
  });

  it("includes rules via PriceBook.include", async () => {
    const app = await createTestApp(prisma);

    const priceBook = await prisma.priceBook.create({
      data: {
        appId: app.id,
        kind: "CUSTOMER",
        currency: "USD",
        effectiveFrom: new Date(),
      },
    });

    await prisma.priceRule.create({
      data: {
        priceBookId: priceBook.id,
        priority: 10,
        match: { eventType: "llm.tokens.v1", provider: "openai" },
        rule: { type: "per_unit", field: "inputTokens", unitPrice: 0.001 },
      },
    });

    const result = await prisma.priceBook.findUnique({
      where: { id: priceBook.id },
      include: { rules: true },
    });

    expect(result).not.toBeNull();
    expect(result!.rules).toHaveLength(1);
    expect(result!.rules[0].priceBookId).toBe(priceBook.id);
  });
});
