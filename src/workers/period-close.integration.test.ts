import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
  createTestTeam,
  createTestBillingEntity,
  createTestBundle,
  randomSuffix,
} from "../services/test-db-helper.js";
import { PeriodCloseService } from "../services/period-close.service.js";
import { LedgerService } from "../services/ledger.service.js";
import { disconnectPrisma } from "../lib/prisma.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://dictator@localhost:5432/billing_test";

let prisma: PrismaClient;

beforeAll(() => {
  // LedgerService internally uses getPrismaClient() which reads DATABASE_URL
  process.env.DATABASE_URL = TEST_DB_URL;
  prisma = getTestPrisma();
});

afterAll(async () => {
  await disconnectPrisma();
  await disconnectTestPrisma();
});

async function setupContractFixture(opts: {
  pricingMode:
    | "FIXED"
    | "FIXED_PLUS_TRUEUP"
    | "MIN_COMMIT_TRUEUP"
    | "CUSTOM_INVOICE_ONLY";
  billingPeriod?: "MONTHLY" | "QUARTERLY";
  startsAt?: Date;
}) {
  const app = await createTestApp(prisma);
  const team = await createTestTeam(prisma);
  const be = await createTestBillingEntity(prisma, { teamId: team.id });
  const bundle = await createTestBundle(prisma);

  await prisma.bundleApp.create({
    data: { bundleId: bundle.id, appId: app.id },
  });

  // Add a meter policy so appId can be resolved for ledger entries
  await prisma.bundleMeterPolicy.create({
    data: {
      bundleId: bundle.id,
      appId: app.id,
      meterKey: "default",
      limitType: "NONE",
      enforcement: "NONE",
      overageBilling: "NONE",
    },
  });

  const contract = await prisma.contract.create({
    data: {
      billToId: be.id,
      bundleId: bundle.id,
      currency: "USD",
      billingPeriod: opts.billingPeriod ?? "MONTHLY",
      termsDays: 30,
      pricingMode: opts.pricingMode,
      startsAt: opts.startsAt ?? new Date("2025-01-01T00:00:00Z"),
      status: "ACTIVE",
    },
  });

  return { app, team, be, bundle, contract };
}

async function createBillableLineItems(
  appId: string,
  billToId: string,
  teamId: string,
  count: number,
  amountMinor: number,
  timestamp: Date,
) {
  const pb = await prisma.priceBook.create({
    data: {
      appId,
      kind: "CUSTOMER",
      currency: "USD",
      effectiveFrom: new Date("2025-01-01T00:00:00Z"),
    },
  });
  const rule = await prisma.priceRule.create({
    data: {
      priceBookId: pb.id,
      priority: 1,
      match: { eventType: "llm.tokens.v1" },
      rule: { type: "flat", amount: amountMinor },
    },
  });

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = await prisma.billableLineItem.create({
      data: {
        appId,
        billToId,
        teamId,
        timestamp,
        priceBookId: pb.id,
        priceRuleId: rule.id,
        amountMinor,
        currency: "USD",
        description: `Usage item ${i}`,
        inputsSnapshot: { eventType: "llm.tokens.v1", amount: amountMinor },
      },
    });
    ids.push(item.id);
  }

  return { priceBook: pb, rule, ids };
}

async function loadContractWithRelations(contractId: string) {
  return prisma.contract.findUniqueOrThrow({
    where: { id: contractId },
    include: {
      bundle: {
        include: {
          meterPolicies: {
            select: {
              appId: true,
              meterKey: true,
              includedAmount: true,
            },
          },
        },
      },
      overrides: {
        select: {
          appId: true,
          meterKey: true,
          includedAmount: true,
        },
      },
    },
  });
}

describe("PeriodCloseService", () => {
  describe("FIXED mode", () => {
    it("generates a single BASE_FEE invoice", async () => {
      const { contract } = await setupContractFixture({
        pricingMode: "FIXED",
        startsAt: new Date("2025-01-01T00:00:00Z"),
      });

      const service = new PeriodCloseService(prisma, new LedgerService());
      const contractWithRelations = await loadContractWithRelations(
        contract.id,
      );

      const result = await service.closeContractPeriod(
        contractWithRelations,
        new Date("2025-02-01T00:00:00Z"),
      );

      expect(result.contractId).toBe(contract.id);
      expect(result.status).toBe("ISSUED");
      expect(result.lineItemCount).toBe(1);

      const invoice = await prisma.invoice.findUnique({
        where: { id: result.invoiceId },
        include: { lineItems: true },
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.status).toBe("ISSUED");
      expect(invoice!.lineItems).toHaveLength(1);
      expect(invoice!.lineItems[0].type).toBe("BASE_FEE");
      expect(invoice!.issuedAt).not.toBeNull();
    });
  });

  describe("FIXED_PLUS_TRUEUP mode", () => {
    it("generates correct overage lines for usage exceeding included amounts", async () => {
      const fixture = await setupContractFixture({
        pricingMode: "FIXED_PLUS_TRUEUP",
        startsAt: new Date("2025-01-01T00:00:00Z"),
      });

      await prisma.bundleMeterPolicy.create({
        data: {
          bundleId: fixture.bundle.id,
          appId: fixture.app.id,
          meterKey: "llm.tokens.v1",
          limitType: "INCLUDED",
          includedAmount: 100,
          enforcement: "SOFT",
          overageBilling: "PER_UNIT",
        },
      });

      await createBillableLineItems(
        fixture.app.id,
        fixture.be.id,
        fixture.team.id,
        3,
        50,
        new Date("2025-01-15T00:00:00Z"),
      );

      const service = new PeriodCloseService(prisma, new LedgerService());
      const contractWithRelations = await loadContractWithRelations(
        fixture.contract.id,
      );

      const result = await service.closeContractPeriod(
        contractWithRelations,
        new Date("2025-02-01T00:00:00Z"),
      );

      expect(result.lineItemCount).toBeGreaterThanOrEqual(2);

      const invoice = await prisma.invoice.findUnique({
        where: { id: result.invoiceId },
        include: { lineItems: true },
      });
      expect(invoice).not.toBeNull();

      const baseFee = invoice!.lineItems.find(
        (li) => li.type === "BASE_FEE",
      );
      const trueup = invoice!.lineItems.find(
        (li) => li.type === "USAGE_TRUEUP",
      );

      expect(baseFee).toBeDefined();
      expect(trueup).toBeDefined();
      expect(trueup!.amountMinor).toBe(50); // 150 total - 100 included = 50
    });
  });

  describe("MIN_COMMIT_TRUEUP mode", () => {
    it("charges the greater of usage vs minimum commit", async () => {
      const fixture = await setupContractFixture({
        pricingMode: "MIN_COMMIT_TRUEUP",
        startsAt: new Date("2025-01-01T00:00:00Z"),
      });

      await createBillableLineItems(
        fixture.app.id,
        fixture.be.id,
        fixture.team.id,
        2,
        75,
        new Date("2025-01-15T00:00:00Z"),
      );

      const service = new PeriodCloseService(prisma, new LedgerService());
      const contractWithRelations = await loadContractWithRelations(
        fixture.contract.id,
      );

      const result = await service.closeContractPeriod(
        contractWithRelations,
        new Date("2025-02-01T00:00:00Z"),
      );

      const invoice = await prisma.invoice.findUnique({
        where: { id: result.invoiceId },
        include: { lineItems: true },
      });
      expect(invoice).not.toBeNull();

      const baseFee = invoice!.lineItems.find(
        (li) => li.type === "BASE_FEE",
      );
      expect(baseFee).toBeDefined();
      // With min commit = 0, usage total 150 is the charge
      expect(baseFee!.amountMinor).toBe(150);

      const trueupLines = invoice!.lineItems.filter(
        (li) => li.type === "USAGE_TRUEUP",
      );
      expect(trueupLines).toHaveLength(1);
      expect(trueupLines[0].amountMinor).toBe(150);
    });
  });

  describe("CUSTOM_INVOICE_ONLY mode", () => {
    it("creates a DRAFT invoice for manual review", async () => {
      const fixture = await setupContractFixture({
        pricingMode: "CUSTOM_INVOICE_ONLY",
        startsAt: new Date("2025-01-01T00:00:00Z"),
      });

      await createBillableLineItems(
        fixture.app.id,
        fixture.be.id,
        fixture.team.id,
        1,
        200,
        new Date("2025-01-15T00:00:00Z"),
      );

      const service = new PeriodCloseService(prisma, new LedgerService());
      const contractWithRelations = await loadContractWithRelations(
        fixture.contract.id,
      );

      const result = await service.closeContractPeriod(
        contractWithRelations,
        new Date("2025-02-01T00:00:00Z"),
      );

      expect(result.status).toBe("DRAFT");

      const invoice = await prisma.invoice.findUnique({
        where: { id: result.invoiceId },
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.status).toBe("DRAFT");
      expect(invoice!.issuedAt).toBeNull();
    });
  });

  describe("idempotency", () => {
    it("does not create duplicate invoices for the same period", async () => {
      const { contract } = await setupContractFixture({
        pricingMode: "FIXED",
        startsAt: new Date("2025-01-01T00:00:00Z"),
      });

      const service = new PeriodCloseService(prisma, new LedgerService());
      const asOf = new Date("2025-02-01T00:00:00Z");
      const contractWithRelations = await loadContractWithRelations(
        contract.id,
      );

      // First run
      const result1 = await service.closeContractPeriod(
        contractWithRelations,
        asOf,
      );
      expect(result1.invoiceId).toBeDefined();

      // Second run via runPeriodClose should skip (idempotency check)
      const runResult = await service.runPeriodClose(asOf);

      // Find our specific contract in the results
      const ourSkipped = runResult.skipped;
      expect(ourSkipped).toBeGreaterThanOrEqual(1);

      // Verify only one invoice exists for this contract/period
      const invoices = await prisma.invoice.findMany({
        where: { contractId: contract.id },
      });
      expect(invoices).toHaveLength(1);
    });
  });

  describe("ledger entries", () => {
    it("creates ledger entries for each invoice line item", async () => {
      const fixture = await setupContractFixture({
        pricingMode: "FIXED_PLUS_TRUEUP",
        startsAt: new Date("2025-01-01T00:00:00Z"),
      });

      await prisma.bundleMeterPolicy.create({
        data: {
          bundleId: fixture.bundle.id,
          appId: fixture.app.id,
          meterKey: "llm.tokens.v1",
          limitType: "INCLUDED",
          includedAmount: 10,
          enforcement: "SOFT",
          overageBilling: "PER_UNIT",
        },
      });

      await createBillableLineItems(
        fixture.app.id,
        fixture.be.id,
        fixture.team.id,
        2,
        50,
        new Date("2025-01-15T00:00:00Z"),
      );

      const service = new PeriodCloseService(prisma, new LedgerService());
      const contractWithRelations = await loadContractWithRelations(
        fixture.contract.id,
      );

      const result = await service.closeContractPeriod(
        contractWithRelations,
        new Date("2025-02-01T00:00:00Z"),
      );

      const entries = await prisma.ledgerEntry.findMany({
        where: {
          billToId: fixture.be.id,
          referenceId: result.invoiceId,
        },
      });

      // BASE_FEE + USAGE_TRUEUP = 2 ledger entries
      expect(entries.length).toBe(2);
    });
  });

  describe("multiple contracts in single run", () => {
    it("worker handles multiple contracts in a single run", async () => {
      const startsAt = new Date("2025-01-01T00:00:00Z");

      await setupContractFixture({ pricingMode: "FIXED", startsAt });
      await setupContractFixture({ pricingMode: "FIXED", startsAt });

      const service = new PeriodCloseService(prisma, new LedgerService());
      const result = await service.runPeriodClose(
        new Date("2025-02-01T00:00:00Z"),
      );

      // At minimum both our new contracts should be processed
      expect(result.processed).toBeGreaterThanOrEqual(2);
      expect(result.invoices.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("quarterly billing period", () => {
    it("closes quarterly periods correctly", async () => {
      const { contract } = await setupContractFixture({
        pricingMode: "FIXED",
        billingPeriod: "QUARTERLY",
        startsAt: new Date("2025-01-01T00:00:00Z"),
      });

      const service = new PeriodCloseService(prisma, new LedgerService());

      // Before quarter end — check that this specific contract's period has not ended
      const contracts = await service.findContractsDueForClose(
        new Date("2025-02-15T00:00:00Z"),
      );
      const ourContract = contracts.find((c) => c.id === contract.id);
      expect(ourContract).toBeUndefined();

      // After quarter end — our contract should be due
      const contracts2 = await service.findContractsDueForClose(
        new Date("2025-04-01T00:00:00Z"),
      );
      const ourContract2 = contracts2.find((c) => c.id === contract.id);
      expect(ourContract2).toBeDefined();
    });
  });

  describe("contract filtering", () => {
    it("skips non-ACTIVE contracts", async () => {
      const app = await createTestApp(prisma);
      const team = await createTestTeam(prisma);
      const be = await createTestBillingEntity(prisma, {
        teamId: team.id,
      });
      const bundle = await createTestBundle(prisma);

      const draftContract = await prisma.contract.create({
        data: {
          billToId: be.id,
          bundleId: bundle.id,
          currency: "USD",
          billingPeriod: "MONTHLY",
          termsDays: 30,
          pricingMode: "FIXED",
          startsAt: new Date("2025-01-01T00:00:00Z"),
          status: "DRAFT",
        },
      });

      const service = new PeriodCloseService(prisma, new LedgerService());
      const contracts = await service.findContractsDueForClose(
        new Date("2025-02-01T00:00:00Z"),
      );

      const found = contracts.find((c) => c.id === draftContract.id);
      expect(found).toBeUndefined();
    });
  });
});
