import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, PrismaClient, UsageEvent } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
  createTestTeam,
  createTestBillingEntity,
  randomSuffix,
} from "./test-db-helper.js";
import {
  PricingEngine,
  NoPriceBookFoundError,
  NoMatchingRuleError,
} from "./pricing-engine.service.js";

let prisma: PrismaClient;
let engine: PricingEngine;

beforeAll(() => {
  prisma = getTestPrisma();
  engine = new PricingEngine(prisma);
});

afterAll(async () => {
  await disconnectTestPrisma();
});

async function createTestSetup(prisma: PrismaClient) {
  const app = await createTestApp(prisma);
  const team = await createTestTeam(prisma);
  const be = await createTestBillingEntity(prisma, { teamId: team.id });
  return { app, team, be };
}

async function createPriceBooks(
  prisma: PrismaClient,
  appId: string,
  opts: { effectiveFrom?: Date; effectiveTo?: Date } = {},
) {
  const effectiveFrom =
    opts.effectiveFrom ?? new Date("2025-01-01T00:00:00Z");
  const effectiveTo = opts.effectiveTo ?? null;

  const cogs = await prisma.priceBook.create({
    data: {
      appId,
      kind: "COGS",
      currency: "USD",
      effectiveFrom,
      effectiveTo,
    },
  });

  const customer = await prisma.priceBook.create({
    data: {
      appId,
      kind: "CUSTOMER",
      currency: "USD",
      effectiveFrom,
      effectiveTo,
    },
  });

  return { cogs, customer };
}

function makeUsageEvent(
  appId: string,
  teamId: string,
  billToId: string,
  payload: Record<string, unknown>,
  overrides: Partial<UsageEvent> = {},
): UsageEvent {
  return {
    id: overrides.id ?? `ue-${randomSuffix()}`,
    appId,
    teamId,
    billToId,
    userId: overrides.userId ?? null,
    eventType: overrides.eventType ?? "llm.tokens.v1",
    timestamp: overrides.timestamp ?? new Date("2025-06-15T12:00:00Z"),
    idempotencyKey: overrides.idempotencyKey ?? `key-${randomSuffix()}`,
    payload: payload as unknown as Prisma.JsonValue,
    source: overrides.source ?? "test",
    pricedAt: overrides.pricedAt ?? null,
    createdAt: overrides.createdAt ?? new Date(),
  };
}

describe("PricingEngine — integration", () => {
  describe("COGS and CUSTOMER line items", () => {
    it("produces exactly two line items per event", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 25 },
        },
      });

      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 75 },
        },
      });

      const event = makeUsageEvent(app.id, team.id, be.id, {
        provider: "openai",
        inputTokens: 500,
        outputTokens: 100,
      });

      const result = await engine.priceEvent(event);

      expect(result.lineItems).toHaveLength(2);
      expect(result.lineItems[0].priceBookId).toBe(cogs.id);
      expect(result.lineItems[1].priceBookId).toBe(customer.id);
    });
  });

  describe("error cases — priceEvent", () => {
    it("throws NoPriceBookFoundError when no COGS book exists", async () => {
      const { app, team, be } = await createTestSetup(prisma);

      // Only create CUSTOMER book, no COGS
      await prisma.priceBook.create({
        data: {
          appId: app.id,
          kind: "CUSTOMER",
          currency: "USD",
          effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        },
      });

      const event = makeUsageEvent(app.id, team.id, be.id, {
        inputTokens: 100,
      });

      await expect(engine.priceEvent(event)).rejects.toThrow(
        NoPriceBookFoundError,
      );
    });

    it("throws NoMatchingRuleError when no rule matches", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      // Rules only match llm.image.v1, but event is llm.tokens.v1
      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 10,
          match: { eventType: "llm.image.v1" },
          rule: { type: "flat", amount: 50 },
        },
      });

      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 10,
          match: { eventType: "llm.image.v1" },
          rule: { type: "flat", amount: 100 },
        },
      });

      const event = makeUsageEvent(app.id, team.id, be.id, {
        inputTokens: 100,
      });

      await expect(engine.priceEvent(event)).rejects.toThrow(
        NoMatchingRuleError,
      );
    });
  });

  describe("persistLineItems", () => {
    it("persists line items to the database", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 25 },
        },
      });

      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 75 },
        },
      });

      const event = makeUsageEvent(app.id, team.id, be.id, {
        provider: "openai",
        inputTokens: 500,
      });

      const result = await engine.priceEvent(event);
      const ids = await engine.persistLineItems(result);

      expect(ids).toHaveLength(2);

      const items = await prisma.billableLineItem.findMany({
        where: { id: { in: ids } },
        orderBy: { createdAt: "asc" },
      });

      expect(items).toHaveLength(2);
      expect(items[0].appId).toBe(app.id);
      expect(items[0].billToId).toBe(be.id);
      expect(items[0].teamId).toBe(team.id);
      expect(items[0].usageEventId).toBe(event.id);
    });
  });

  describe("effective date filtering", () => {
    it("selects price book effective at event timestamp", async () => {
      const { app, team, be } = await createTestSetup(prisma);

      // Old price books (expired)
      await prisma.priceBook.create({
        data: {
          appId: app.id,
          kind: "COGS",
          currency: "USD",
          version: 1,
          effectiveFrom: new Date("2024-01-01T00:00:00Z"),
          effectiveTo: new Date("2025-01-01T00:00:00Z"),
        },
      });

      // Current price books
      const currentCogs = await prisma.priceBook.create({
        data: {
          appId: app.id,
          kind: "COGS",
          currency: "USD",
          version: 2,
          effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        },
      });

      const currentCustomer = await prisma.priceBook.create({
        data: {
          appId: app.id,
          kind: "CUSTOMER",
          currency: "USD",
          version: 2,
          effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        },
      });

      await prisma.priceRule.create({
        data: {
          priceBookId: currentCogs.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 77 },
        },
      });

      await prisma.priceRule.create({
        data: {
          priceBookId: currentCustomer.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 150 },
        },
      });

      const event = makeUsageEvent(
        app.id,
        team.id,
        be.id,
        { inputTokens: 100 },
        { timestamp: new Date("2025-06-15T12:00:00Z") },
      );

      const result = await engine.priceEvent(event);

      expect(result.lineItems[0].priceBookId).toBe(currentCogs.id);
      expect(result.lineItems[0].amountMinor).toBe(77);
      expect(result.lineItems[1].priceBookId).toBe(currentCustomer.id);
      expect(result.lineItems[1].amountMinor).toBe(150);
    });
  });
});
