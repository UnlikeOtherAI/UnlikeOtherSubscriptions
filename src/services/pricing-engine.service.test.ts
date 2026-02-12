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
  InvalidRuleError,
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
    createdAt: overrides.createdAt ?? new Date(),
  };
}

describe("PricingEngine", () => {
  describe("flat rule", () => {
    it("produces correct amount for a flat rule", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 50 },
        },
      });

      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 100 },
        },
      });

      const event = makeUsageEvent(app.id, team.id, be.id, {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1000,
        outputTokens: 500,
      });

      const result = await engine.priceEvent(event);

      expect(result.lineItems).toHaveLength(2);

      const cogsItem = result.lineItems[0];
      expect(cogsItem.amountMinor).toBe(50);
      expect(cogsItem.priceBookId).toBe(cogs.id);
      expect(cogsItem.currency).toBe("USD");
      expect(cogsItem.inputsSnapshot).toHaveProperty("ruleType", "flat");

      const customerItem = result.lineItems[1];
      expect(customerItem.amountMinor).toBe(100);
      expect(customerItem.priceBookId).toBe(customer.id);
    });
  });

  describe("per_unit rule", () => {
    it("multiplies quantity by unit price correctly", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "per_unit", field: "inputTokens", unitPrice: 0.003 },
        },
      });

      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "per_unit", field: "inputTokens", unitPrice: 0.01 },
        },
      });

      const event = makeUsageEvent(app.id, team.id, be.id, {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1500,
        outputTokens: 500,
      });

      const result = await engine.priceEvent(event);

      expect(result.lineItems).toHaveLength(2);

      // COGS: 1500 * 0.003 = 4.5 => round to 5
      const cogsItem = result.lineItems[0];
      expect(cogsItem.amountMinor).toBe(Math.round(1500 * 0.003));
      expect(cogsItem.inputsSnapshot).toHaveProperty("ruleType", "per_unit");
      expect(cogsItem.inputsSnapshot).toHaveProperty("quantity", 1500);
      expect(cogsItem.inputsSnapshot).toHaveProperty("unitPrice", 0.003);

      // Customer: 1500 * 0.01 = 15
      const customerItem = result.lineItems[1];
      expect(customerItem.amountMinor).toBe(15);
    });
  });

  describe("tiered rule", () => {
    it("applies correct tier rates for graduated pricing", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      // Simple flat for COGS
      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 50 },
        },
      });

      // Tiered for customer
      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: {
            type: "tiered",
            field: "inputTokens",
            tiers: [
              { upTo: 1000, unitPrice: 0.01 },
              { upTo: 5000, unitPrice: 0.005 },
              { upTo: null, unitPrice: 0.002 },
            ],
          },
        },
      });

      // 3000 tokens: 1000 * 0.01 + 2000 * 0.005 = 10 + 10 = 20
      const event = makeUsageEvent(app.id, team.id, be.id, {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 3000,
        outputTokens: 0,
      });

      const result = await engine.priceEvent(event);
      const customerItem = result.lineItems[1];

      expect(customerItem.amountMinor).toBe(20);
      expect(customerItem.inputsSnapshot).toHaveProperty("ruleType", "tiered");
      const snapshot = customerItem.inputsSnapshot as Record<string, unknown>;
      expect(snapshot.quantity).toBe(3000);
      expect(Array.isArray(snapshot.tiers)).toBe(true);
    });

    it("applies final unbounded tier correctly", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 10 },
        },
      });

      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: {
            type: "tiered",
            field: "inputTokens",
            tiers: [
              { upTo: 1000, unitPrice: 0.01 },
              { upTo: null, unitPrice: 0.005 },
            ],
          },
        },
      });

      // 6000 tokens: 1000 * 0.01 + 5000 * 0.005 = 10 + 25 = 35
      const event = makeUsageEvent(app.id, team.id, be.id, {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 6000,
        outputTokens: 0,
      });

      const result = await engine.priceEvent(event);
      expect(result.lineItems[1].amountMinor).toBe(35);
    });
  });

  describe("rule priority", () => {
    it("highest-priority rule wins when multiple match", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      // COGS: generic low-priority rule
      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 1,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 100 },
        },
      });

      // COGS: specific high-priority rule for openai
      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 20,
          match: { eventType: "llm.tokens.v1", provider: "openai" },
          rule: { type: "flat", amount: 30 },
        },
      });

      // Customer: generic low-priority rule
      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 1,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 200 },
        },
      });

      // Customer: specific high-priority rule for openai
      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 20,
          match: { eventType: "llm.tokens.v1", provider: "openai" },
          rule: { type: "flat", amount: 60 },
        },
      });

      const event = makeUsageEvent(app.id, team.id, be.id, {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1000,
        outputTokens: 500,
      });

      const result = await engine.priceEvent(event);

      // High-priority rule wins for both COGS and CUSTOMER
      expect(result.lineItems[0].amountMinor).toBe(30);
      expect(result.lineItems[1].amountMinor).toBe(60);
    });
  });

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

  describe("inputsSnapshot", () => {
    it("captures computation inputs for reproducibility", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "per_unit", field: "inputTokens", unitPrice: 0.005 },
        },
      });

      await prisma.priceRule.create({
        data: {
          priceBookId: customer.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "per_unit", field: "inputTokens", unitPrice: 0.01 },
        },
      });

      const event = makeUsageEvent(app.id, team.id, be.id, {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 2000,
        outputTokens: 300,
      });

      const result = await engine.priceEvent(event);

      const snapshot = result.lineItems[0]
        .inputsSnapshot as Record<string, unknown>;
      expect(snapshot.ruleType).toBe("per_unit");
      expect(snapshot.field).toBe("inputTokens");
      expect(snapshot.quantity).toBe(2000);
      expect(snapshot.unitPrice).toBe(0.005);
      expect(snapshot.payload).toBeDefined();
    });
  });

  describe("error cases", () => {
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

    it("throws InvalidRuleError for unsupported rule type", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const invalidRule = { type: "unknown_type" } as any;
      expect(() =>
        engine.evaluateRule("rule-1", invalidRule, { inputTokens: 100 }),
      ).toThrow(InvalidRuleError);
    });

    it("throws InvalidRuleError when per_unit field missing from payload", () => {
      expect(() =>
        engine.evaluateRule(
          "rule-1",
          { type: "per_unit", field: "nonExistent", unitPrice: 0.01 },
          { inputTokens: 100 },
        ),
      ).toThrow(InvalidRuleError);
    });
  });

  describe("persistLineItems", () => {
    it("persists line items to the database", async () => {
      const { app, team, be } = await createTestSetup(prisma);
      const { cogs, customer } = await createPriceBooks(prisma, app.id);

      const cogsRule = await prisma.priceRule.create({
        data: {
          priceBookId: cogs.id,
          priority: 10,
          match: { eventType: "llm.tokens.v1" },
          rule: { type: "flat", amount: 25 },
        },
      });

      const customerRule = await prisma.priceRule.create({
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
      const oldCogs = await prisma.priceBook.create({
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
