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

describe("Plan integration", () => {
  it("creates a Plan with correct fields and defaults", async () => {
    const app = await createTestApp(prisma);
    const code = `plan-${randomSuffix()}`;

    const plan = await prisma.plan.create({
      data: { appId: app.id, code, name: "Pro Monthly" },
    });

    expect(plan.id).toBeDefined();
    expect(plan.appId).toBe(app.id);
    expect(plan.code).toBe(code);
    expect(plan.name).toBe("Pro Monthly");
    expect(plan.status).toBe("ACTIVE");
    expect(plan.createdAt).toBeInstanceOf(Date);
    expect(plan.updatedAt).toBeInstanceOf(Date);
  });

  it("enforces unique constraint on appId + code", async () => {
    const app = await createTestApp(prisma);
    const code = `uniq-${randomSuffix()}`;

    await prisma.plan.create({
      data: { appId: app.id, code, name: "Pro" },
    });

    await expect(
      prisma.plan.create({
        data: { appId: app.id, code, name: "Pro Duplicate" },
      }),
    ).rejects.toThrow();
  });

  it("allows same code for different apps", async () => {
    const app1 = await createTestApp(prisma);
    const app2 = await createTestApp(prisma);
    const code = `shared-${randomSuffix()}`;

    const plan1 = await prisma.plan.create({
      data: { appId: app1.id, code, name: "Pro App 1" },
    });

    const plan2 = await prisma.plan.create({
      data: { appId: app2.id, code, name: "Pro App 2" },
    });

    expect(plan1.appId).toBe(app1.id);
    expect(plan2.appId).toBe(app2.id);
    expect(plan1.code).toBe(code);
    expect(plan2.code).toBe(code);
  });

  it("enforces FK to App — rejects invalid appId", async () => {
    await expect(
      prisma.plan.create({
        data: {
          appId: "non-existent-app-id",
          code: `fk-${randomSuffix()}`,
          name: "Pro",
        },
      }),
    ).rejects.toThrow();
  });

  it("looks up Plan by composite unique appId_code", async () => {
    const app = await createTestApp(prisma);
    const code = `lookup-${randomSuffix()}`;

    const created = await prisma.plan.create({
      data: { appId: app.id, code, name: "Starter" },
    });

    const found = await prisma.plan.findUnique({
      where: { appId_code: { appId: app.id, code } },
    });

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("includes stripeProductMaps via Plan.include", async () => {
    const app = await createTestApp(prisma);
    const code = `incl-spm-${randomSuffix()}`;

    const plan = await prisma.plan.create({
      data: { appId: app.id, code, name: "Enterprise" },
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
    expect(result!.stripeProductMaps[0].planId).toBe(plan.id);
    expect(result!.stripeProductMaps[1].planId).toBe(plan.id);
  });

  it("includes subscriptions via Plan.include", async () => {
    const app = await createTestApp(prisma);
    const team = await prisma.team.create({
      data: { name: "Team A", kind: "STANDARD" },
    });
    const code = `incl-sub-${randomSuffix()}`;

    const plan = await prisma.plan.create({
      data: { appId: app.id, code, name: "Enterprise" },
    });

    await prisma.teamSubscription.create({
      data: {
        teamId: team.id,
        stripeSubscriptionId: `sub_${randomSuffix()}`,
        status: "ACTIVE",
        planId: plan.id,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });

    const result = await prisma.plan.findUnique({
      where: { id: plan.id },
      include: { subscriptions: true },
    });

    expect(result).not.toBeNull();
    expect(result!.subscriptions).toHaveLength(1);
    expect(result!.subscriptions[0].planId).toBe(plan.id);
  });
});
