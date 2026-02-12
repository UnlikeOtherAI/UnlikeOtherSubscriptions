import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestBillingEntity,
  createTestBundle,
  randomSuffix,
} from "./test-db-helper.js";

let prisma: PrismaClient;

beforeAll(() => {
  prisma = getTestPrisma();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

async function createTestContract(
  prisma: PrismaClient,
  billToId: string,
  bundleId: string,
) {
  return prisma.contract.create({
    data: {
      billToId,
      bundleId,
      currency: "USD",
      billingPeriod: "MONTHLY",
      termsDays: 30,
      startsAt: new Date("2025-01-01"),
      pricingMode: "FIXED",
    },
  });
}

async function createTestInvoice(
  prisma: PrismaClient,
  billToId: string,
  overrides: {
    contractId?: string;
    status?: "DRAFT" | "ISSUED" | "PAID" | "VOID";
    periodStart?: Date;
    periodEnd?: Date;
  } = {},
) {
  return prisma.invoice.create({
    data: {
      billToId,
      contractId: overrides.contractId ?? null,
      periodStart: overrides.periodStart ?? new Date("2025-01-01"),
      periodEnd: overrides.periodEnd ?? new Date("2025-02-01"),
      status: overrides.status ?? "DRAFT",
      subtotalMinor: 10000,
      taxMinor: 2000,
      totalMinor: 12000,
    },
  });
}

describe("Invoice integration", () => {
  it("creates an Invoice with all required fields", async () => {
    const be = await createTestBillingEntity(prisma);

    const invoice = await prisma.invoice.create({
      data: {
        billToId: be.id,
        periodStart: new Date("2025-01-01"),
        periodEnd: new Date("2025-02-01"),
        subtotalMinor: 50000,
        taxMinor: 10000,
        totalMinor: 60000,
      },
    });

    expect(invoice.id).toBeDefined();
    expect(invoice.billToId).toBe(be.id);
    expect(invoice.contractId).toBeNull();
    expect(invoice.periodStart).toEqual(new Date("2025-01-01"));
    expect(invoice.periodEnd).toEqual(new Date("2025-02-01"));
    expect(invoice.status).toBe("DRAFT");
    expect(invoice.subtotalMinor).toBe(50000);
    expect(invoice.taxMinor).toBe(10000);
    expect(invoice.totalMinor).toBe(60000);
    expect(invoice.externalRef).toBeNull();
    expect(invoice.issuedAt).toBeNull();
    expect(invoice.dueAt).toBeNull();
    expect(invoice.createdAt).toBeInstanceOf(Date);
    expect(invoice.updatedAt).toBeInstanceOf(Date);
  });

  it("supports all InvoiceStatus enum values", async () => {
    const statuses = ["DRAFT", "ISSUED", "PAID", "VOID"] as const;

    for (const status of statuses) {
      const be = await createTestBillingEntity(prisma);

      const invoice = await prisma.invoice.create({
        data: {
          billToId: be.id,
          periodStart: new Date("2025-01-01"),
          periodEnd: new Date("2025-02-01"),
          status,
          subtotalMinor: 1000,
          taxMinor: 200,
          totalMinor: 1200,
        },
      });

      expect(invoice.status).toBe(status);
    }
  });

  it("links to Contract via contractId", async () => {
    const be = await createTestBillingEntity(prisma);
    const bundle = await createTestBundle(prisma);
    const contract = await createTestContract(prisma, be.id, bundle.id);

    const invoice = await prisma.invoice.create({
      data: {
        billToId: be.id,
        contractId: contract.id,
        periodStart: new Date("2025-01-01"),
        periodEnd: new Date("2025-02-01"),
        subtotalMinor: 5000,
        taxMinor: 0,
        totalMinor: 5000,
      },
    });

    expect(invoice.contractId).toBe(contract.id);

    const fetched = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { contract: true },
    });

    expect(fetched).not.toBeNull();
    expect(fetched!.contract).not.toBeNull();
    expect(fetched!.contract!.id).toBe(contract.id);
  });

  it("allows contractId to be null", async () => {
    const be = await createTestBillingEntity(prisma);

    const invoice = await prisma.invoice.create({
      data: {
        billToId: be.id,
        periodStart: new Date("2025-06-01"),
        periodEnd: new Date("2025-07-01"),
        subtotalMinor: 3000,
        taxMinor: 600,
        totalMinor: 3600,
      },
    });

    expect(invoice.contractId).toBeNull();
  });

  it("stores optional fields: externalRef, issuedAt, dueAt", async () => {
    const be = await createTestBillingEntity(prisma);
    const issuedAt = new Date("2025-02-01T10:00:00Z");
    const dueAt = new Date("2025-03-01T10:00:00Z");

    const invoice = await prisma.invoice.create({
      data: {
        billToId: be.id,
        periodStart: new Date("2025-01-01"),
        periodEnd: new Date("2025-02-01"),
        status: "ISSUED",
        subtotalMinor: 7500,
        taxMinor: 1500,
        totalMinor: 9000,
        externalRef: "XERO-INV-001",
        issuedAt,
        dueAt,
      },
    });

    expect(invoice.externalRef).toBe("XERO-INV-001");
    expect(invoice.issuedAt).toEqual(issuedAt);
    expect(invoice.dueAt).toEqual(dueAt);
  });

  it("queries invoices by billToId and period", async () => {
    const be = await createTestBillingEntity(prisma);

    await createTestInvoice(prisma, be.id, {
      periodStart: new Date("2025-01-01"),
      periodEnd: new Date("2025-02-01"),
    });
    await createTestInvoice(prisma, be.id, {
      periodStart: new Date("2025-02-01"),
      periodEnd: new Date("2025-03-01"),
    });
    await createTestInvoice(prisma, be.id, {
      periodStart: new Date("2025-06-01"),
      periodEnd: new Date("2025-07-01"),
    });

    const q1Invoices = await prisma.invoice.findMany({
      where: {
        billToId: be.id,
        periodStart: { gte: new Date("2025-01-01") },
        periodEnd: { lte: new Date("2025-04-01") },
      },
    });

    expect(q1Invoices).toHaveLength(2);
    expect(q1Invoices.every((inv) => inv.billToId === be.id)).toBe(true);
  });

  it("enforces FK to BillingEntity — rejects invalid billToId", async () => {
    await expect(
      prisma.invoice.create({
        data: {
          billToId: "non-existent-be",
          periodStart: new Date("2025-01-01"),
          periodEnd: new Date("2025-02-01"),
          subtotalMinor: 1000,
          taxMinor: 0,
          totalMinor: 1000,
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to Contract — rejects invalid contractId", async () => {
    const be = await createTestBillingEntity(prisma);

    await expect(
      prisma.invoice.create({
        data: {
          billToId: be.id,
          contractId: "non-existent-contract",
          periodStart: new Date("2025-01-01"),
          periodEnd: new Date("2025-02-01"),
          subtotalMinor: 1000,
          taxMinor: 0,
          totalMinor: 1000,
        },
      }),
    ).rejects.toThrow();
  });

  it("includes lineItems via Invoice.include", async () => {
    const be = await createTestBillingEntity(prisma);
    const invoice = await createTestInvoice(prisma, be.id);

    await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        type: "BASE_FEE",
        description: "Monthly base fee",
        quantity: 1,
        unitPriceMinor: 10000,
        amountMinor: 10000,
      },
    });

    const fetched = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { lineItems: true },
    });

    expect(fetched).not.toBeNull();
    expect(fetched!.lineItems).toHaveLength(1);
    expect(fetched!.lineItems[0].type).toBe("BASE_FEE");
  });
});

describe("InvoiceLineItem integration", () => {
  it("creates an InvoiceLineItem with all required fields", async () => {
    const be = await createTestBillingEntity(prisma);
    const invoice = await createTestInvoice(prisma, be.id);

    const lineItem = await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        type: "BASE_FEE",
        description: "Enterprise base fee",
        quantity: 1,
        unitPriceMinor: 50000,
        amountMinor: 50000,
      },
    });

    expect(lineItem.id).toBeDefined();
    expect(lineItem.invoiceId).toBe(invoice.id);
    expect(lineItem.appId).toBeNull();
    expect(lineItem.type).toBe("BASE_FEE");
    expect(lineItem.description).toBe("Enterprise base fee");
    expect(lineItem.quantity).toBe(1);
    expect(lineItem.unitPriceMinor).toBe(50000);
    expect(lineItem.amountMinor).toBe(50000);
    expect(lineItem.usageSummary).toBeNull();
    expect(lineItem.createdAt).toBeInstanceOf(Date);
  });

  it("supports all InvoiceLineItemType enum values", async () => {
    const be = await createTestBillingEntity(prisma);
    const invoice = await createTestInvoice(prisma, be.id);

    const types = [
      "BASE_FEE",
      "USAGE_TRUEUP",
      "ADDON",
      "CREDIT",
      "ADJUSTMENT",
    ] as const;

    for (const type of types) {
      const lineItem = await prisma.invoiceLineItem.create({
        data: {
          invoiceId: invoice.id,
          type,
          description: `Test ${type}`,
          quantity: 1,
          unitPriceMinor: 100,
          amountMinor: 100,
        },
      });

      expect(lineItem.type).toBe(type);
    }
  });

  it("stores and retrieves usageSummary JSONB correctly", async () => {
    const be = await createTestBillingEntity(prisma);
    const invoice = await createTestInvoice(prisma, be.id);

    const usageSummary = {
      meters: {
        "llm.tokens.in": { total: 5000000, unit: "tokens" },
        "llm.tokens.out": { total: 1200000, unit: "tokens" },
      },
      totalAmountMinor: 15000,
      priceRuleIds: ["rule-1", "rule-2"],
      period: {
        start: "2025-01-01T00:00:00Z",
        end: "2025-02-01T00:00:00Z",
      },
    };

    const lineItem = await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        type: "USAGE_TRUEUP",
        description: "LLM token overage",
        quantity: 6200000,
        unitPriceMinor: 1,
        amountMinor: 15000,
        usageSummary,
      },
    });

    const fetched = await prisma.invoiceLineItem.findUnique({
      where: { id: lineItem.id },
    });

    expect(fetched).not.toBeNull();
    expect(fetched!.usageSummary).toEqual(usageSummary);
  });

  it("allows null usageSummary", async () => {
    const be = await createTestBillingEntity(prisma);
    const invoice = await createTestInvoice(prisma, be.id);

    const lineItem = await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        type: "BASE_FEE",
        description: "Base fee",
        quantity: 1,
        unitPriceMinor: 5000,
        amountMinor: 5000,
      },
    });

    expect(lineItem.usageSummary).toBeNull();
  });

  it("stores optional appId", async () => {
    const be = await createTestBillingEntity(prisma);
    const invoice = await createTestInvoice(prisma, be.id);

    const withApp = await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        appId: `app-${randomSuffix()}`,
        type: "USAGE_TRUEUP",
        description: "Usage for app X",
        quantity: 100,
        unitPriceMinor: 50,
        amountMinor: 5000,
      },
    });

    const withoutApp = await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        type: "CREDIT",
        description: "Promotional credit",
        quantity: 1,
        unitPriceMinor: -2000,
        amountMinor: -2000,
      },
    });

    expect(withApp.appId).toBeDefined();
    expect(withoutApp.appId).toBeNull();
  });

  it("enforces FK to Invoice — rejects invalid invoiceId", async () => {
    await expect(
      prisma.invoiceLineItem.create({
        data: {
          invoiceId: "non-existent-invoice",
          type: "BASE_FEE",
          description: "Should fail",
          quantity: 1,
          unitPriceMinor: 100,
          amountMinor: 100,
        },
      }),
    ).rejects.toThrow();
  });

  it("queries line items by invoiceId", async () => {
    const be = await createTestBillingEntity(prisma);
    const invoice1 = await createTestInvoice(prisma, be.id);
    const invoice2 = await createTestInvoice(prisma, be.id);

    await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice1.id,
        type: "BASE_FEE",
        description: "Base fee inv1",
        quantity: 1,
        unitPriceMinor: 10000,
        amountMinor: 10000,
      },
    });

    await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice1.id,
        type: "USAGE_TRUEUP",
        description: "Overage inv1",
        quantity: 500,
        unitPriceMinor: 10,
        amountMinor: 5000,
      },
    });

    await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice2.id,
        type: "BASE_FEE",
        description: "Base fee inv2",
        quantity: 1,
        unitPriceMinor: 10000,
        amountMinor: 10000,
      },
    });

    const inv1Items = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: invoice1.id },
    });

    expect(inv1Items).toHaveLength(2);
    expect(inv1Items.every((li) => li.invoiceId === invoice1.id)).toBe(true);
  });
});
