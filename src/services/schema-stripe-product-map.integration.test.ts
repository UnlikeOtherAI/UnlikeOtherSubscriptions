import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
  randomSuffix,
} from "./test-db-helper.js";

let prisma: PrismaClient;

beforeAll(() => {
  prisma = getTestPrisma();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("StripeProductMap integration", () => {
  it("links to a Plan via planId", async () => {
    const app = await createTestApp(prisma);
    const plan = await prisma.plan.create({
      data: { appId: app.id, code: `plan-${randomSuffix()}`, name: "Pro" },
    });

    const spm = await prisma.stripeProductMap.create({
      data: {
        appId: app.id,
        planId: plan.id,
        addonId: null,
        stripeProductId: `prod_${randomSuffix()}`,
        stripePriceId: `price_${randomSuffix()}`,
        kind: "BASE",
      },
    });

    expect(spm.planId).toBe(plan.id);
    expect(spm.addonId).toBeNull();
    expect(spm.kind).toBe("BASE");
  });

  it("links to an Addon via addonId", async () => {
    const app = await createTestApp(prisma);
    const addon = await prisma.addon.create({
      data: { appId: app.id, code: `addon-${randomSuffix()}`, name: "Storage" },
    });

    const spm = await prisma.stripeProductMap.create({
      data: {
        appId: app.id,
        planId: null,
        addonId: addon.id,
        stripeProductId: `prod_${randomSuffix()}`,
        stripePriceId: `price_${randomSuffix()}`,
        kind: "ADDON",
      },
    });

    expect(spm.addonId).toBe(addon.id);
    expect(spm.planId).toBeNull();
    expect(spm.kind).toBe("ADDON");
  });

  it("enforces unique constraint on appId + stripePriceId", async () => {
    const app = await createTestApp(prisma);
    const priceId = `price_uniq_${randomSuffix()}`;

    await prisma.stripeProductMap.create({
      data: {
        appId: app.id,
        stripeProductId: `prod_${randomSuffix()}`,
        stripePriceId: priceId,
        kind: "BASE",
      },
    });

    await expect(
      prisma.stripeProductMap.create({
        data: {
          appId: app.id,
          stripeProductId: `prod_${randomSuffix()}`,
          stripePriceId: priceId,
          kind: "SEAT",
        },
      }),
    ).rejects.toThrow();
  });

  it("allows same stripePriceId for different apps", async () => {
    const app1 = await createTestApp(prisma);
    const app2 = await createTestApp(prisma);
    const priceId = `price_shared_${randomSuffix()}`;

    const spm1 = await prisma.stripeProductMap.create({
      data: {
        appId: app1.id,
        stripeProductId: `prod_${randomSuffix()}`,
        stripePriceId: priceId,
        kind: "BASE",
      },
    });

    const spm2 = await prisma.stripeProductMap.create({
      data: {
        appId: app2.id,
        stripeProductId: `prod_${randomSuffix()}`,
        stripePriceId: priceId,
        kind: "BASE",
      },
    });

    expect(spm1.appId).toBe(app1.id);
    expect(spm2.appId).toBe(app2.id);
  });

  it("enforces FK to Plan — rejects invalid planId", async () => {
    const app = await createTestApp(prisma);

    await expect(
      prisma.stripeProductMap.create({
        data: {
          appId: app.id,
          planId: "non-existent-plan-id",
          stripeProductId: `prod_${randomSuffix()}`,
          stripePriceId: `price_${randomSuffix()}`,
          kind: "BASE",
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to Addon — rejects invalid addonId", async () => {
    const app = await createTestApp(prisma);

    await expect(
      prisma.stripeProductMap.create({
        data: {
          appId: app.id,
          addonId: "non-existent-addon-id",
          stripeProductId: `prod_${randomSuffix()}`,
          stripePriceId: `price_${randomSuffix()}`,
          kind: "ADDON",
        },
      }),
    ).rejects.toThrow();
  });

  it("queries StripeProductMaps via Plan include", async () => {
    const app = await createTestApp(prisma);
    const plan = await prisma.plan.create({
      data: { appId: app.id, code: `plan-incl-${randomSuffix()}`, name: "Pro" },
    });

    await prisma.stripeProductMap.create({
      data: {
        appId: app.id,
        planId: plan.id,
        stripeProductId: `prod_base_${randomSuffix()}`,
        stripePriceId: `price_base_${randomSuffix()}`,
        kind: "BASE",
      },
    });

    await prisma.stripeProductMap.create({
      data: {
        appId: app.id,
        planId: plan.id,
        stripeProductId: `prod_seat_${randomSuffix()}`,
        stripePriceId: `price_seat_${randomSuffix()}`,
        kind: "SEAT",
      },
    });

    const result = await prisma.plan.findUnique({
      where: { id: plan.id },
      include: { stripeProductMaps: true },
    });

    expect(result).not.toBeNull();
    expect(result!.stripeProductMaps).toHaveLength(2);
    expect(result!.stripeProductMaps.every((m) => m.planId === plan.id)).toBe(
      true,
    );
  });

  it("queries StripeProductMaps via Addon include", async () => {
    const app = await createTestApp(prisma);
    const addon = await prisma.addon.create({
      data: {
        appId: app.id,
        code: `addon-incl-${randomSuffix()}`,
        name: "Storage",
      },
    });

    await prisma.stripeProductMap.create({
      data: {
        appId: app.id,
        addonId: addon.id,
        stripeProductId: `prod_addon_${randomSuffix()}`,
        stripePriceId: `price_addon_${randomSuffix()}`,
        kind: "ADDON",
      },
    });

    const result = await prisma.addon.findUnique({
      where: { id: addon.id },
      include: { stripeProductMaps: true },
    });

    expect(result).not.toBeNull();
    expect(result!.stripeProductMaps).toHaveLength(1);
    expect(result!.stripeProductMaps[0].addonId).toBe(addon.id);
  });

  it("supports all StripeProductMapKind values", async () => {
    const app = await createTestApp(prisma);
    const kinds = ["BASE", "SEAT", "ADDON", "OVERAGE", "TOPUP"] as const;

    for (const kind of kinds) {
      const spm = await prisma.stripeProductMap.create({
        data: {
          appId: app.id,
          stripeProductId: `prod_${kind}_${randomSuffix()}`,
          stripePriceId: `price_${kind}_${randomSuffix()}`,
          kind,
        },
      });
      expect(spm.kind).toBe(kind);
    }
  });
});
