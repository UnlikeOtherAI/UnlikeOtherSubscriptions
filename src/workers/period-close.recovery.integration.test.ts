import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
  createTestTeam,
  createTestBillingEntity,
  createTestBundle,
} from "../services/test-db-helper.js";
import { PeriodCloseService } from "../services/period-close.service.js";
import { LedgerService } from "../services/ledger.service.js";
import { disconnectPrisma } from "../lib/prisma.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://dictator@localhost:5432/billing_test";

let prisma: PrismaClient;

beforeAll(() => {
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

  for (let i = 0; i < count; i++) {
    await prisma.billableLineItem.create({
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
  }
}

async function loadContractWithRelations(contractId: string) {
  return prisma.contract.findUniqueOrThrow({
    where: { id: contractId },
    include: {
      bundle: {
        include: {
          meterPolicies: {
            select: { appId: true, meterKey: true, includedAmount: true },
          },
        },
      },
      overrides: {
        select: { appId: true, meterKey: true, includedAmount: true },
      },
    },
  });
}

describe("PeriodCloseService — MIN_COMMIT_TRUEUP non-double-charge", () => {
  it("invoice total equals BASE_FEE only, detail lines have zero amount", async () => {
    const fixture = await setupContractFixture({
      pricingMode: "MIN_COMMIT_TRUEUP",
      startsAt: new Date("2025-01-01T00:00:00Z"),
    });

    await createBillableLineItems(
      fixture.app.id,
      fixture.be.id,
      fixture.team.id,
      3,
      100,
      new Date("2025-01-10T00:00:00Z"),
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

    // Total usage is 300 (3 * 100). With minCommit=0, chargeAmount=300
    const baseFee = invoice!.lineItems.find(
      (li) => li.type === "BASE_FEE",
    );
    expect(baseFee!.amountMinor).toBe(300);

    // Detail lines should have amountMinor=0 (informational only)
    const trueupLines = invoice!.lineItems.filter(
      (li) => li.type === "USAGE_TRUEUP",
    );
    for (const line of trueupLines) {
      expect(line.amountMinor).toBe(0);
    }

    // Invoice total must equal BASE_FEE only, not BASE_FEE + USAGE_TRUEUP
    expect(invoice!.totalMinor).toBe(300);
    expect(invoice!.subtotalMinor).toBe(300);

    // Verify ledger entries also reflect correct non-doubled amounts
    const entries = await prisma.ledgerEntry.findMany({
      where: {
        billToId: fixture.be.id,
        referenceId: result.invoiceId,
      },
    });
    const totalLedger = entries.reduce(
      (sum, e) => sum + e.amountMinor,
      0,
    );
    expect(totalLedger).toBe(300);
  });
});

describe("PeriodCloseService — ledger recovery on rerun", () => {
  it("repairs missing ledger entries when invoice already exists", async () => {
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

    // First run: create invoice + ledger entries normally
    const service = new PeriodCloseService(prisma, new LedgerService());
    const contractWithRelations = await loadContractWithRelations(
      fixture.contract.id,
    );
    const result = await service.closeContractPeriod(
      contractWithRelations,
      new Date("2025-02-01T00:00:00Z"),
    );

    // Verify ledger entries were created (BASE_FEE + USAGE_TRUEUP = 2)
    const entriesBefore = await prisma.ledgerEntry.findMany({
      where: {
        billToId: fixture.be.id,
        referenceId: result.invoiceId,
      },
    });
    expect(entriesBefore.length).toBe(2);

    // Simulate partial failure: delete one ledger entry
    await prisma.ledgerEntry.delete({
      where: { id: entriesBefore[0].id },
    });

    const entriesAfterDelete = await prisma.ledgerEntry.findMany({
      where: {
        billToId: fixture.be.id,
        referenceId: result.invoiceId,
      },
    });
    expect(entriesAfterDelete.length).toBe(1);

    // Rerun period close — should detect invoice exists and repair ledger
    const rerunResult = await service.runPeriodClose(
      new Date("2025-02-01T00:00:00Z"),
    );

    // Contract should be skipped (invoice exists) but ledger repaired
    expect(rerunResult.skipped).toBeGreaterThanOrEqual(1);

    // Verify the missing ledger entry was recreated
    const entriesAfterRepair = await prisma.ledgerEntry.findMany({
      where: {
        billToId: fixture.be.id,
        referenceId: result.invoiceId,
      },
    });
    expect(entriesAfterRepair.length).toBe(2);

    // Verify no duplicate invoices were created
    const invoices = await prisma.invoice.findMany({
      where: { contractId: fixture.contract.id },
    });
    expect(invoices).toHaveLength(1);
  });

  it("is idempotent: repeated reruns do not create duplicate ledger entries", async () => {
    const fixture = await setupContractFixture({
      pricingMode: "FIXED",
      startsAt: new Date("2025-01-01T00:00:00Z"),
    });

    const service = new PeriodCloseService(prisma, new LedgerService());
    const asOf = new Date("2025-02-01T00:00:00Z");

    // First run
    await service.runPeriodClose(asOf);

    // Count ledger entries after first run
    const entriesAfterFirst = await prisma.ledgerEntry.findMany({
      where: { billToId: fixture.be.id },
    });
    const countAfterFirst = entriesAfterFirst.length;

    // Second run
    await service.runPeriodClose(asOf);

    // Third run
    await service.runPeriodClose(asOf);

    // Count should remain the same
    const entriesAfterThird = await prisma.ledgerEntry.findMany({
      where: { billToId: fixture.be.id },
    });
    expect(entriesAfterThird.length).toBe(countAfterFirst);

    // Still only one invoice
    const invoices = await prisma.invoice.findMany({
      where: { contractId: fixture.contract.id },
    });
    expect(invoices).toHaveLength(1);
  });
});
