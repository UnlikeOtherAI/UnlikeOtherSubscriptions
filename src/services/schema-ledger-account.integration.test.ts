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

describe("LedgerAccount integration", () => {
  it("creates a LedgerAccount with correct fields", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });

    const account = await prisma.ledgerAccount.create({
      data: {
        appId: app.id,
        billToId: be.id,
        type: "WALLET",
      },
    });

    expect(account.id).toBeDefined();
    expect(account.appId).toBe(app.id);
    expect(account.billToId).toBe(be.id);
    expect(account.type).toBe("WALLET");
    expect(account.createdAt).toBeInstanceOf(Date);
  });

  it("supports all LedgerAccountType enum values", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });

    const types = [
      "WALLET",
      "ACCOUNTS_RECEIVABLE",
      "REVENUE",
      "COGS",
      "TAX",
    ] as const;

    for (const type of types) {
      const account = await prisma.ledgerAccount.create({
        data: { appId: app.id, billToId: be.id, type },
      });
      expect(account.type).toBe(type);
    }
  });

  it("enforces unique constraint on (appId, billToId, type)", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });

    await prisma.ledgerAccount.create({
      data: { appId: app.id, billToId: be.id, type: "REVENUE" },
    });

    await expect(
      prisma.ledgerAccount.create({
        data: { appId: app.id, billToId: be.id, type: "REVENUE" },
      }),
    ).rejects.toThrow();
  });

  it("allows same (appId, billToId) with different type", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });

    const wallet = await prisma.ledgerAccount.create({
      data: { appId: app.id, billToId: be.id, type: "WALLET" },
    });
    const revenue = await prisma.ledgerAccount.create({
      data: { appId: app.id, billToId: be.id, type: "REVENUE" },
    });

    expect(wallet.id).not.toBe(revenue.id);
    expect(wallet.type).toBe("WALLET");
    expect(revenue.type).toBe("REVENUE");
  });

  it("allows same (appId, type) with different billToId", async () => {
    const app = await createTestApp(prisma);
    const team1 = await createTestTeam(prisma);
    const team2 = await createTestTeam(prisma);
    const be1 = await createTestBillingEntity(prisma, { teamId: team1.id });
    const be2 = await createTestBillingEntity(prisma, { teamId: team2.id });

    const acct1 = await prisma.ledgerAccount.create({
      data: { appId: app.id, billToId: be1.id, type: "WALLET" },
    });
    const acct2 = await prisma.ledgerAccount.create({
      data: { appId: app.id, billToId: be2.id, type: "WALLET" },
    });

    expect(acct1.id).not.toBe(acct2.id);
  });

  it("enforces FK to BillingEntity — rejects invalid billToId", async () => {
    const app = await createTestApp(prisma);

    await expect(
      prisma.ledgerAccount.create({
        data: {
          appId: app.id,
          billToId: "non-existent-be-id",
          type: "WALLET",
        },
      }),
    ).rejects.toThrow();
  });

  it("includes entries via LedgerAccount.include", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const be = await createTestBillingEntity(prisma, { teamId: team.id });

    const account = await prisma.ledgerAccount.create({
      data: { appId: app.id, billToId: be.id, type: "REVENUE" },
    });

    await prisma.ledgerEntry.create({
      data: {
        appId: app.id,
        billToId: be.id,
        ledgerAccountId: account.id,
        type: "SUBSCRIPTION_CHARGE",
        amountMinor: 2999,
        currency: "USD",
        referenceType: "STRIPE_INVOICE",
        idempotencyKey: `idem-${randomSuffix()}`,
      },
    });

    const result = await prisma.ledgerAccount.findUnique({
      where: { id: account.id },
      include: { entries: true },
    });

    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].ledgerAccountId).toBe(account.id);
  });
});
