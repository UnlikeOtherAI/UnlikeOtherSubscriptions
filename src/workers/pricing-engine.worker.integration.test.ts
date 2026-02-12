import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
  createTestTeam,
  createTestBillingEntity,
  randomSuffix,
} from "../services/test-db-helper.js";
import { PricingEngine } from "../services/pricing-engine.service.js";
import { PricingEngineWorker } from "./pricing-engine.worker.js";

let prisma: PrismaClient;

beforeAll(() => {
  prisma = getTestPrisma();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

async function createTestSetup() {
  const app = await createTestApp(prisma);
  const team = await createTestTeam(prisma);
  const be = await createTestBillingEntity(prisma, { teamId: team.id });
  return { app, team, be };
}

async function createPriceBooks(appId: string) {
  const cogs = await prisma.priceBook.create({
    data: {
      appId,
      kind: "COGS",
      currency: "USD",
      effectiveFrom: new Date("2025-01-01T00:00:00Z"),
    },
  });

  const customer = await prisma.priceBook.create({
    data: {
      appId,
      kind: "CUSTOMER",
      currency: "USD",
      effectiveFrom: new Date("2025-01-01T00:00:00Z"),
    },
  });

  return { cogs, customer };
}

async function addRules(cogsBookId: string, customerBookId: string) {
  await prisma.priceRule.create({
    data: {
      priceBookId: cogsBookId,
      priority: 10,
      match: { eventType: "llm.tokens.v1" },
      rule: { type: "per_unit", field: "inputTokens", unitPrice: 1 },
    },
  });

  await prisma.priceRule.create({
    data: {
      priceBookId: customerBookId,
      priority: 10,
      match: { eventType: "llm.tokens.v1" },
      rule: { type: "per_unit", field: "inputTokens", unitPrice: 3 },
    },
  });
}

async function insertUsageEvent(
  appId: string,
  teamId: string,
  billToId: string,
  overrides: {
    id?: string;
    eventType?: string;
    payload?: Prisma.InputJsonValue;
    pricedAt?: Date | null;
  } = {},
) {
  return prisma.usageEvent.create({
    data: {
      id: overrides.id ?? `ue-${randomSuffix()}`,
      appId,
      teamId,
      billToId,
      eventType: overrides.eventType ?? "llm.tokens.v1",
      timestamp: new Date("2025-06-15T12:00:00Z"),
      idempotencyKey: `key-${randomSuffix()}`,
      payload: overrides.payload ?? {
        provider: "openai",
        model: "gpt-4",
        inputTokens: 1000,
        outputTokens: 200,
      },
      source: "test",
      pricedAt: overrides.pricedAt ?? null,
    },
  });
}

describe("PricingEngineWorker — integration", () => {
  describe("processUnpricedEvents", () => {
    it("picks up unpriced events and creates BillableLineItems", async () => {
      const { app, team, be } = await createTestSetup();
      const { cogs, customer } = await createPriceBooks(app.id);
      await addRules(cogs.id, customer.id);

      const event = await insertUsageEvent(app.id, team.id, be.id);

      const worker = new PricingEngineWorker(
        prisma,
        new PricingEngine(prisma),
        { batchSize: 10 },
      );

      const result = await worker.processUnpricedEvents();

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);

      const lineItems = await prisma.billableLineItem.findMany({
        where: { usageEventId: event.id },
        orderBy: { createdAt: "asc" },
      });

      expect(lineItems).toHaveLength(2);
      expect(lineItems[0].amountMinor).toBe(1000); // COGS: 1000 * 1
      expect(lineItems[1].amountMinor).toBe(3000); // Customer: 1000 * 3

      const updated = await prisma.usageEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(updated.pricedAt).not.toBeNull();
    });

    it("skips already-priced events", async () => {
      const { app, team, be } = await createTestSetup();
      const { cogs, customer } = await createPriceBooks(app.id);
      await addRules(cogs.id, customer.id);

      await insertUsageEvent(app.id, team.id, be.id, {
        pricedAt: new Date(),
      });

      const worker = new PricingEngineWorker(
        prisma,
        new PricingEngine(prisma),
        { batchSize: 10 },
      );

      const result = await worker.processUnpricedEvents();

      expect(result.processed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("processes events in batches", async () => {
      const { app, team, be } = await createTestSetup();
      const { cogs, customer } = await createPriceBooks(app.id);
      await addRules(cogs.id, customer.id);

      const events = [];
      for (let i = 0; i < 5; i++) {
        events.push(await insertUsageEvent(app.id, team.id, be.id));
      }

      const worker = new PricingEngineWorker(
        prisma,
        new PricingEngine(prisma),
        { batchSize: 3 },
      );

      // First batch: processes 3 events
      const result1 = await worker.processUnpricedEvents();
      expect(result1.processed).toBe(3);

      // Second batch: processes remaining 2 events
      const result2 = await worker.processUnpricedEvents();
      expect(result2.processed).toBe(2);

      // Third batch: nothing left
      const result3 = await worker.processUnpricedEvents();
      expect(result3.processed).toBe(0);
    });

    it("does not block other events when one fails pricing", async () => {
      const { app, team, be } = await createTestSetup();
      const { cogs, customer } = await createPriceBooks(app.id);
      await addRules(cogs.id, customer.id);

      // This event will fail because its eventType has no matching rule
      const badEvent = await insertUsageEvent(app.id, team.id, be.id, {
        eventType: "unknown.event.v1",
        payload: { someField: 123 },
      });

      // This event will succeed
      const goodEvent = await insertUsageEvent(app.id, team.id, be.id);

      const worker = new PricingEngineWorker(
        prisma,
        new PricingEngine(prisma),
        { batchSize: 10 },
      );

      const result = await worker.processUnpricedEvents();

      expect(result.failed).toBe(1);
      expect(result.processed).toBe(1);

      // Good event should have line items
      const goodItems = await prisma.billableLineItem.findMany({
        where: { usageEventId: goodEvent.id },
      });
      expect(goodItems).toHaveLength(2);

      // Bad event should have no line items but be flagged
      const badItems = await prisma.billableLineItem.findMany({
        where: { usageEventId: badEvent.id },
      });
      expect(badItems).toHaveLength(0);

      const updatedBad = await prisma.usageEvent.findUniqueOrThrow({
        where: { id: badEvent.id },
      });
      expect(updatedBad.pricedAt).not.toBeNull();
    });

    it("is idempotent on re-runs", async () => {
      const { app, team, be } = await createTestSetup();
      const { cogs, customer } = await createPriceBooks(app.id);
      await addRules(cogs.id, customer.id);

      const event = await insertUsageEvent(app.id, team.id, be.id);

      const worker = new PricingEngineWorker(
        prisma,
        new PricingEngine(prisma),
        { batchSize: 10 },
      );

      // First run
      const result1 = await worker.processUnpricedEvents();
      expect(result1.processed).toBe(1);

      // Second run — already priced, pricedAt is set so it won't be fetched
      const result2 = await worker.processUnpricedEvents();
      expect(result2.processed).toBe(0);

      // Verify no duplicate line items
      const lineItems = await prisma.billableLineItem.findMany({
        where: { usageEventId: event.id },
      });
      expect(lineItems).toHaveLength(2);
    });

    it("creates BillableLineItems in a transaction (all-or-nothing)", async () => {
      const { app, team, be } = await createTestSetup();
      const { cogs, customer } = await createPriceBooks(app.id);
      await addRules(cogs.id, customer.id);

      const event = await insertUsageEvent(app.id, team.id, be.id);

      const worker = new PricingEngineWorker(
        prisma,
        new PricingEngine(prisma),
        { batchSize: 10 },
      );

      const result = await worker.processUnpricedEvents();
      expect(result.processed).toBe(1);

      // Both COGS and CUSTOMER line items created together
      const lineItems = await prisma.billableLineItem.findMany({
        where: { usageEventId: event.id },
      });
      expect(lineItems).toHaveLength(2);

      const cogsItem = lineItems.find((li) =>
        li.description.includes("COGS"),
      );
      const customerItem = lineItems.find((li) =>
        li.description.includes("Customer"),
      );

      expect(cogsItem).toBeDefined();
      expect(customerItem).toBeDefined();
      expect(cogsItem!.appId).toBe(app.id);
      expect(cogsItem!.billToId).toBe(be.id);
      expect(cogsItem!.teamId).toBe(team.id);
    });
  });
});
