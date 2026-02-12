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

async function createTestLedgerAccount(
  prisma: PrismaClient,
  appId: string,
  billToId: string,
  type: "WALLET" | "ACCOUNTS_RECEIVABLE" | "REVENUE" | "COGS" | "TAX" = "REVENUE",
) {
  return prisma.ledgerAccount.create({
    data: { appId, billToId, type },
  });
}

describe("LedgerEntry integration", () => {
  it("creates a LedgerEntry with all required fields", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const account = await createTestLedgerAccount(prisma, app.id, be.id);

    const entry = await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be.id,
        ledgerAccountId: account.id,
        type: "SUBSCRIPTION_CHARGE",
        amountMinor: 2999,
        currency: "USD",
        referenceType: "STRIPE_INVOICE",
        referenceId: "in_abc123",
        idempotencyKey: `idem-${randomSuffix()}`,
      },
    });

    expect(entry.id).toBeDefined();
    expect(entry.appId).toBe(app.id);
    expect(entry.billToId).toBe(be.id);
    expect(entry.ledgerAccountId).toBe(account.id);
    expect(entry.type).toBe("SUBSCRIPTION_CHARGE");
    expect(entry.amountMinor).toBe(2999);
    expect(entry.currency).toBe("USD");
    expect(entry.referenceType).toBe("STRIPE_INVOICE");
    expect(entry.referenceId).toBe("in_abc123");
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("enforces unique idempotencyKey — rejects duplicate financial actions", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const account = await createTestLedgerAccount(prisma, app.id, be.id);

    const idemKey = `idem-unique-${randomSuffix()}`;

    await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be.id,
        ledgerAccountId: account.id,
        type: "TOPUP",
        amountMinor: 10000,
        currency: "USD",
        referenceType: "STRIPE_PAYMENT_INTENT",
        idempotencyKey: idemKey,
      },
    });

    await expect(
      prisma.ledgerEntry.create({
        data: {
          appId: app.id,
          billToId: be.id,
          ledgerAccountId: account.id,
          type: "TOPUP",
          amountMinor: 10000,
          currency: "USD",
          referenceType: "STRIPE_PAYMENT_INTENT",
          idempotencyKey: idemKey,
        },
      }),
    ).rejects.toThrow();
  });

  it("queries entries by billToId + time range", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const account = await createTestLedgerAccount(prisma, app.id, be.id);

    const t1 = new Date("2025-01-15T00:00:00Z");
    const t2 = new Date("2025-02-15T00:00:00Z");
    const t3 = new Date("2025-03-15T00:00:00Z");

    for (const ts of [t1, t2, t3]) {
      await prisma.ledgerEntry.create({
        data: {
          appId: app.id,
          billToId: be.id,
          ledgerAccountId: account.id,
          timestamp: ts,
          type: "USAGE_CHARGE",
          amountMinor: -500,
          currency: "USD",
          referenceType: "USAGE_EVENT",
          idempotencyKey: `idem-range-${ts.toISOString()}-${randomSuffix()}`,
        },
      });
    }

    const janFebEntries = await prisma.ledgerEntry.findMany({
      where: {
        billToId: be.id,
        timestamp: {
          gte: new Date("2025-01-01T00:00:00Z"),
          lt: new Date("2025-03-01T00:00:00Z"),
        },
      },
    });

    expect(janFebEntries).toHaveLength(2);
    expect(janFebEntries.every((e) => e.billToId === be.id)).toBe(true);
  });

  it("filters by billToId — does not return entries for other billing entities", async () => {
    const app = await createTestApp(prisma);
    const team1 = await createTestTeam(prisma);
    const team2 = await createTestTeam(prisma);
    const be1 = await createTestBillingEntity(prisma, { teamId: team1.id });
    const be2 = await createTestBillingEntity(prisma, { teamId: team2.id });
    const acct1 = await createTestLedgerAccount(prisma, app.id, be1.id);
    const acct2 = await createTestLedgerAccount(prisma, app.id, be2.id);

    const ts = new Date("2025-06-01T00:00:00Z");

    await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be1.id,
        ledgerAccountId: acct1.id,
        timestamp: ts,
        type: "TOPUP",
        amountMinor: 5000,
        currency: "USD",
        referenceType: "STRIPE_PAYMENT_INTENT",
        idempotencyKey: `idem-be1-${randomSuffix()}`,
      },
    });

    await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be2.id,
        ledgerAccountId: acct2.id,
        timestamp: ts,
        type: "TOPUP",
        amountMinor: 3000,
        currency: "USD",
        referenceType: "STRIPE_PAYMENT_INTENT",
        idempotencyKey: `idem-be2-${randomSuffix()}`,
      },
    });

    const be1Entries = await prisma.ledgerEntry.findMany({
      where: {
        billToId: be1.id,
        timestamp: { gte: new Date("2025-06-01T00:00:00Z") },
      },
    });

    expect(be1Entries).toHaveLength(1);
    expect(be1Entries[0].amountMinor).toBe(5000);
  });

  it("stores and retrieves JSONB metadata correctly", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const account = await createTestLedgerAccount(prisma, app.id, be.id);

    const metadata = {
      invoiceId: "inv_12345",
      planCode: "pro-monthly",
      seats: 10,
      prorated: true,
      breakdown: {
        base: 2999,
        seatCharge: 500,
        discount: -200,
      },
      tags: ["renewal", "auto-charge"],
    };

    const entry = await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be.id,
        ledgerAccountId: account.id,
        type: "SUBSCRIPTION_CHARGE",
        amountMinor: 3299,
        currency: "USD",
        referenceType: "STRIPE_INVOICE",
        referenceId: "in_meta_test",
        idempotencyKey: `idem-meta-${randomSuffix()}`,
        metadata,
      },
    });

    const fetched = await prisma.ledgerEntry.findUnique({
      where: { id: entry.id },
    });

    expect(fetched).not.toBeNull();
    expect(fetched!.metadata).toEqual(metadata);
  });

  it("stores null metadata when not provided", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const account = await createTestLedgerAccount(prisma, app.id, be.id);

    const entry = await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be.id,
        ledgerAccountId: account.id,
        type: "REFUND",
        amountMinor: 1500,
        currency: "GBP",
        referenceType: "MANUAL",
        idempotencyKey: `idem-null-meta-${randomSuffix()}`,
      },
    });

    const fetched = await prisma.ledgerEntry.findUnique({
      where: { id: entry.id },
    });

    expect(fetched!.metadata).toBeNull();
  });

  it("supports all LedgerEntryType enum values", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const account = await createTestLedgerAccount(prisma, app.id, be.id);

    const types = [
      "TOPUP",
      "SUBSCRIPTION_CHARGE",
      "USAGE_CHARGE",
      "REFUND",
      "ADJUSTMENT",
      "INVOICE_PAYMENT",
      "COGS_ACCRUAL",
    ] as const;

    for (const type of types) {
      const entry = await prisma.ledgerEntry.create({
        data: {
          appId: app.id,
          billToId: be.id,
          ledgerAccountId: account.id,
          type,
          amountMinor: 100,
          currency: "USD",
          referenceType: "MANUAL",
          idempotencyKey: `idem-type-${type}-${randomSuffix()}`,
        },
      });
      expect(entry.type).toBe(type);
    }
  });

  it("supports all LedgerReferenceType enum values", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const account = await createTestLedgerAccount(prisma, app.id, be.id);

    const refTypes = [
      "STRIPE_INVOICE",
      "STRIPE_PAYMENT_INTENT",
      "USAGE_EVENT",
      "MANUAL",
    ] as const;

    for (const referenceType of refTypes) {
      const entry = await prisma.ledgerEntry.create({
        data: {
          appId: app.id,
          billToId: be.id,
          ledgerAccountId: account.id,
          type: "ADJUSTMENT",
          amountMinor: 50,
          currency: "USD",
          referenceType,
          idempotencyKey: `idem-ref-${referenceType}-${randomSuffix()}`,
        },
      });
      expect(entry.referenceType).toBe(referenceType);
    }
  });

  it("enforces FK to LedgerAccount — rejects invalid ledgerAccountId", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });

    await expect(
      prisma.ledgerEntry.create({
        data: {
          appId: app.id,
          billToId: be.id,
          ledgerAccountId: "non-existent-account-id",
          type: "TOPUP",
          amountMinor: 1000,
          currency: "USD",
          referenceType: "MANUAL",
          idempotencyKey: `idem-fk-${randomSuffix()}`,
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to BillingEntity — rejects invalid billToId", async () => {
    const app = await createTestApp(prisma);

    await expect(
      prisma.ledgerEntry.create({
        data: {
          appId: app.id,
          billToId: "non-existent-be-id",
          ledgerAccountId: "non-existent-account-id",
          type: "TOPUP",
          amountMinor: 1000,
          currency: "USD",
          referenceType: "MANUAL",
          idempotencyKey: `idem-fk-be-${randomSuffix()}`,
        },
      }),
    ).rejects.toThrow();
  });

  it("queries by ledgerAccountId + timestamp index", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const walletAcct = await createTestLedgerAccount(prisma, app.id, be.id, "WALLET");
    const revenueAcct = await createTestLedgerAccount(prisma, app.id, be.id, "REVENUE");

    const ts = new Date("2025-05-01T00:00:00Z");

    await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be.id,
        ledgerAccountId: walletAcct.id,
        timestamp: ts,
        type: "TOPUP",
        amountMinor: 10000,
        currency: "USD",
        referenceType: "STRIPE_PAYMENT_INTENT",
        idempotencyKey: `idem-wallet-${randomSuffix()}`,
      },
    });

    await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be.id,
        ledgerAccountId: revenueAcct.id,
        timestamp: ts,
        type: "SUBSCRIPTION_CHARGE",
        amountMinor: 2999,
        currency: "USD",
        referenceType: "STRIPE_INVOICE",
        idempotencyKey: `idem-revenue-${randomSuffix()}`,
      },
    });

    const walletEntries = await prisma.ledgerEntry.findMany({
      where: {
        ledgerAccountId: walletAcct.id,
        timestamp: { gte: new Date("2025-05-01T00:00:00Z") },
      },
    });

    expect(walletEntries).toHaveLength(1);
    expect(walletEntries[0].type).toBe("TOPUP");
  });

  it("supports optional referenceId", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });
    const account = await createTestLedgerAccount(prisma, app.id, be.id);

    const withRef = await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be.id,
        ledgerAccountId: account.id,
        type: "INVOICE_PAYMENT",
        amountMinor: 5000,
        currency: "USD",
        referenceType: "STRIPE_INVOICE",
        referenceId: "in_ref123",
        idempotencyKey: `idem-withref-${randomSuffix()}`,
      },
    });

    const withoutRef = await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be.id,
        ledgerAccountId: account.id,
        type: "ADJUSTMENT",
        amountMinor: 200,
        currency: "USD",
        referenceType: "MANUAL",
        idempotencyKey: `idem-noref-${randomSuffix()}`,
      },
    });

    expect(withRef.referenceId).toBe("in_ref123");
    expect(withoutRef.referenceId).toBeNull();
  });
});
