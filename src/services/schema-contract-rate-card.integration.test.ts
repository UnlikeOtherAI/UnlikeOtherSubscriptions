import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
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

describe("ContractRateCard integration", () => {
  it("creates a ContractRateCard with CUSTOMER kind", async () => {
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

    const rateCard = await prisma.contractRateCard.create({
      data: {
        contractId: contract.id,
        kind: "CUSTOMER",
        effectiveFrom: new Date("2025-01-01"),
        effectiveTo: new Date("2025-12-31"),
      },
    });

    expect(rateCard.id).toBeDefined();
    expect(rateCard.kind).toBe("CUSTOMER");
    expect(rateCard.effectiveFrom).toEqual(new Date("2025-01-01"));
    expect(rateCard.effectiveTo).toEqual(new Date("2025-12-31"));
  });

  it("creates a ContractRateCard with COGS kind and null effectiveTo", async () => {
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

    const rateCard = await prisma.contractRateCard.create({
      data: {
        contractId: contract.id,
        kind: "COGS",
        effectiveFrom: new Date("2025-01-01"),
      },
    });

    expect(rateCard.kind).toBe("COGS");
    expect(rateCard.effectiveTo).toBeNull();
  });

  it("enforces FK to Contract — rejects invalid contractId", async () => {
    await expect(
      prisma.contractRateCard.create({
        data: {
          contractId: "non-existent-contract",
          kind: "CUSTOMER",
          effectiveFrom: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("allows multiple rate cards per contract", async () => {
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

    const rc1 = await prisma.contractRateCard.create({
      data: {
        contractId: contract.id,
        kind: "CUSTOMER",
        effectiveFrom: new Date("2025-01-01"),
        effectiveTo: new Date("2025-06-30"),
      },
    });

    const rc2 = await prisma.contractRateCard.create({
      data: {
        contractId: contract.id,
        kind: "CUSTOMER",
        effectiveFrom: new Date("2025-07-01"),
      },
    });

    const rc3 = await prisma.contractRateCard.create({
      data: {
        contractId: contract.id,
        kind: "COGS",
        effectiveFrom: new Date("2025-01-01"),
      },
    });

    const result = await prisma.contract.findUnique({
      where: { id: contract.id },
      include: { rateCards: true },
    });

    expect(result!.rateCards).toHaveLength(3);
  });
});
