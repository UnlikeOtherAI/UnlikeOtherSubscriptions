import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
  createTestBundle,
  createTestBillingEntity,
} from "./test-db-helper.js";

let prisma: PrismaClient;

beforeAll(() => {
  prisma = getTestPrisma();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("Contract integration", () => {
  it("creates a Contract with correct fields and defaults", async () => {
    const bundle = await createTestBundle(prisma);
    const be = await createTestBillingEntity(prisma);

    const contract = await prisma.contract.create({
      data: {
        billToId: be.id,
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        startsAt: new Date("2025-01-01"),
        endsAt: new Date("2026-01-01"),
        pricingMode: "FIXED",
      },
    });

    expect(contract.id).toBeDefined();
    expect(contract.status).toBe("DRAFT");
    expect(contract.billToId).toBe(be.id);
    expect(contract.bundleId).toBe(bundle.id);
    expect(contract.currency).toBe("USD");
    expect(contract.billingPeriod).toBe("MONTHLY");
    expect(contract.termsDays).toBe(30);
    expect(contract.pricingMode).toBe("FIXED");
    expect(contract.startsAt).toEqual(new Date("2025-01-01"));
    expect(contract.endsAt).toEqual(new Date("2026-01-01"));
    expect(contract.createdAt).toBeInstanceOf(Date);
    expect(contract.updatedAt).toBeInstanceOf(Date);
  });

  it("allows endsAt to be null (evergreen contract)", async () => {
    const bundle = await createTestBundle(prisma);
    const be = await createTestBillingEntity(prisma);

    const contract = await prisma.contract.create({
      data: {
        billToId: be.id,
        bundleId: bundle.id,
        currency: "EUR",
        billingPeriod: "QUARTERLY",
        termsDays: 60,
        startsAt: new Date("2025-03-01"),
        pricingMode: "FIXED_PLUS_TRUEUP",
      },
    });

    expect(contract.endsAt).toBeNull();
  });

  it("supports all PricingMode values", async () => {
    const modes = [
      "FIXED",
      "FIXED_PLUS_TRUEUP",
      "MIN_COMMIT_TRUEUP",
      "CUSTOM_INVOICE_ONLY",
    ] as const;

    for (const mode of modes) {
      const bundle = await createTestBundle(prisma);
      const be = await createTestBillingEntity(prisma);

      const contract = await prisma.contract.create({
        data: {
          billToId: be.id,
          bundleId: bundle.id,
          currency: "USD",
          billingPeriod: "MONTHLY",
          termsDays: 30,
          startsAt: new Date(),
          pricingMode: mode,
        },
      });

      expect(contract.pricingMode).toBe(mode);
    }
  });

  it("unique partial index prevents two ACTIVE contracts for same billToId", async () => {
    const bundle = await createTestBundle(prisma);
    const be = await createTestBillingEntity(prisma);

    await prisma.contract.create({
      data: {
        billToId: be.id,
        status: "ACTIVE",
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        startsAt: new Date(),
        pricingMode: "FIXED",
      },
    });

    await expect(
      prisma.contract.create({
        data: {
          billToId: be.id,
          status: "ACTIVE",
          bundleId: bundle.id,
          currency: "USD",
          billingPeriod: "MONTHLY",
          termsDays: 30,
          startsAt: new Date(),
          pricingMode: "FIXED",
        },
      }),
    ).rejects.toThrow();
  });

  it("allows multiple DRAFT contracts for same billToId", async () => {
    const bundle = await createTestBundle(prisma);
    const be = await createTestBillingEntity(prisma);

    const c1 = await prisma.contract.create({
      data: {
        billToId: be.id,
        status: "DRAFT",
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        startsAt: new Date(),
        pricingMode: "FIXED",
      },
    });

    const c2 = await prisma.contract.create({
      data: {
        billToId: be.id,
        status: "DRAFT",
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "QUARTERLY",
        termsDays: 60,
        startsAt: new Date(),
        pricingMode: "FIXED_PLUS_TRUEUP",
      },
    });

    expect(c1.id).not.toBe(c2.id);
    expect(c1.billToId).toBe(be.id);
    expect(c2.billToId).toBe(be.id);
  });

  it("allows one ACTIVE and one ENDED contract for same billToId", async () => {
    const bundle = await createTestBundle(prisma);
    const be = await createTestBillingEntity(prisma);

    await prisma.contract.create({
      data: {
        billToId: be.id,
        status: "ENDED",
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        startsAt: new Date("2024-01-01"),
        endsAt: new Date("2024-12-31"),
        pricingMode: "FIXED",
      },
    });

    const active = await prisma.contract.create({
      data: {
        billToId: be.id,
        status: "ACTIVE",
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        startsAt: new Date("2025-01-01"),
        pricingMode: "FIXED",
      },
    });

    expect(active.status).toBe("ACTIVE");
  });

  it("enforces FK to BillingEntity — rejects invalid billToId", async () => {
    const bundle = await createTestBundle(prisma);

    await expect(
      prisma.contract.create({
        data: {
          billToId: "non-existent-be",
          bundleId: bundle.id,
          currency: "USD",
          billingPeriod: "MONTHLY",
          termsDays: 30,
          startsAt: new Date(),
          pricingMode: "FIXED",
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to Bundle — rejects invalid bundleId", async () => {
    const be = await createTestBillingEntity(prisma);

    await expect(
      prisma.contract.create({
        data: {
          billToId: be.id,
          bundleId: "non-existent-bundle",
          currency: "USD",
          billingPeriod: "MONTHLY",
          termsDays: 30,
          startsAt: new Date(),
          pricingMode: "FIXED",
        },
      }),
    ).rejects.toThrow();
  });

  it("includes overrides and rateCards via Contract.include", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);
    const be = await createTestBillingEntity(prisma);

    const contract = await prisma.contract.create({
      data: {
        billToId: be.id,
        status: "ACTIVE",
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        startsAt: new Date(),
        pricingMode: "FIXED",
      },
    });

    await prisma.contractOverride.create({
      data: {
        contractId: contract.id,
        appId: app.id,
        meterKey: "llm.tokens.in",
        limitType: "UNLIMITED",
      },
    });

    await prisma.contractRateCard.create({
      data: {
        contractId: contract.id,
        kind: "CUSTOMER",
        effectiveFrom: new Date("2025-01-01"),
      },
    });

    const result = await prisma.contract.findUnique({
      where: { id: contract.id },
      include: { overrides: true, rateCards: true },
    });

    expect(result).not.toBeNull();
    expect(result!.overrides).toHaveLength(1);
    expect(result!.rateCards).toHaveLength(1);
  });
});

describe("ContractOverride integration", () => {
  it("creates a ContractOverride with all fields", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);
    const be = await createTestBillingEntity(prisma);

    const contract = await prisma.contract.create({
      data: {
        billToId: be.id,
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        startsAt: new Date(),
        pricingMode: "FIXED",
      },
    });

    const override = await prisma.contractOverride.create({
      data: {
        contractId: contract.id,
        appId: app.id,
        meterKey: "llm.tokens.in",
        limitType: "INCLUDED",
        includedAmount: 5000000,
        overageBilling: "PER_UNIT",
        enforcement: "HARD",
        featureFlags: { priority_support: true },
      },
    });

    expect(override.id).toBeDefined();
    expect(override.limitType).toBe("INCLUDED");
    expect(override.includedAmount).toBe(5000000);
    expect(override.overageBilling).toBe("PER_UNIT");
    expect(override.enforcement).toBe("HARD");
    expect(override.featureFlags).toEqual({ priority_support: true });
  });

  it("enforces unique constraint on contractId + appId + meterKey", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);
    const be = await createTestBillingEntity(prisma);

    const contract = await prisma.contract.create({
      data: {
        billToId: be.id,
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        startsAt: new Date(),
        pricingMode: "FIXED",
      },
    });

    await prisma.contractOverride.create({
      data: {
        contractId: contract.id,
        appId: app.id,
        meterKey: "llm.tokens.in",
        limitType: "UNLIMITED",
      },
    });

    await expect(
      prisma.contractOverride.create({
        data: {
          contractId: contract.id,
          appId: app.id,
          meterKey: "llm.tokens.in",
          limitType: "HARD_CAP",
        },
      }),
    ).rejects.toThrow();
  });

  it("allows nullable fields (limitType, overageBilling, enforcement)", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);
    const be = await createTestBillingEntity(prisma);

    const contract = await prisma.contract.create({
      data: {
        billToId: be.id,
        bundleId: bundle.id,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        startsAt: new Date(),
        pricingMode: "FIXED",
      },
    });

    const override = await prisma.contractOverride.create({
      data: {
        contractId: contract.id,
        appId: app.id,
        meterKey: "llm.image",
        featureFlags: { hd_images: true },
      },
    });

    expect(override.limitType).toBeNull();
    expect(override.includedAmount).toBeNull();
    expect(override.overageBilling).toBeNull();
    expect(override.enforcement).toBeNull();
    expect(override.featureFlags).toEqual({ hd_images: true });
  });
});

