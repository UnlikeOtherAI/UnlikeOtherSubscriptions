import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
  createTestTeam,
  randomSuffix,
} from "./test-db-helper.js";

let prisma: PrismaClient;

beforeAll(() => {
  prisma = getTestPrisma();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("TeamSubscription integration", () => {
  it("creates a TeamSubscription with correct fields", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const plan = await prisma.plan.create({
      data: { appId: app.id, code: `plan-${randomSuffix()}`, name: "Pro" },
    });

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 86400000);

    const sub = await prisma.teamSubscription.create({
      data: {
        teamId: team.id,
        stripeSubscriptionId: `sub_${randomSuffix()}`,
        status: "ACTIVE",
        planId: plan.id,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        seatsQuantity: 5,
      },
    });

    expect(sub.id).toBeDefined();
    expect(sub.teamId).toBe(team.id);
    expect(sub.status).toBe("ACTIVE");
    expect(sub.planId).toBe(plan.id);
    expect(sub.seatsQuantity).toBe(5);
    expect(sub.createdAt).toBeInstanceOf(Date);
    expect(sub.updatedAt).toBeInstanceOf(Date);
  });

  it("defaults seatsQuantity to 1", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const plan = await prisma.plan.create({
      data: { appId: app.id, code: `plan-${randomSuffix()}`, name: "Basic" },
    });

    const sub = await prisma.teamSubscription.create({
      data: {
        teamId: team.id,
        stripeSubscriptionId: `sub_${randomSuffix()}`,
        status: "ACTIVE",
        planId: plan.id,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });

    expect(sub.seatsQuantity).toBe(1);
  });

  it("enforces unique stripeSubscriptionId", async () => {
    const app = await createTestApp(prisma);
    const team1 = await createTestTeam(prisma);
    const team2 = await createTestTeam(prisma);
    const plan = await prisma.plan.create({
      data: { appId: app.id, code: `plan-${randomSuffix()}`, name: "Pro" },
    });
    const subId = `sub_uniq_${randomSuffix()}`;

    await prisma.teamSubscription.create({
      data: {
        teamId: team1.id,
        stripeSubscriptionId: subId,
        status: "ACTIVE",
        planId: plan.id,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });

    await expect(
      prisma.teamSubscription.create({
        data: {
          teamId: team2.id,
          stripeSubscriptionId: subId,
          status: "ACTIVE",
          planId: plan.id,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to Team — rejects invalid teamId", async () => {
    const app = await createTestApp(prisma);
    const plan = await prisma.plan.create({
      data: { appId: app.id, code: `plan-${randomSuffix()}`, name: "Pro" },
    });

    await expect(
      prisma.teamSubscription.create({
        data: {
          teamId: "non-existent-team-id",
          stripeSubscriptionId: `sub_${randomSuffix()}`,
          status: "ACTIVE",
          planId: plan.id,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to Plan — rejects invalid planId", async () => {
    const team = await createTestTeam(prisma);

    await expect(
      prisma.teamSubscription.create({
        data: {
          teamId: team.id,
          stripeSubscriptionId: `sub_${randomSuffix()}`,
          status: "ACTIVE",
          planId: "non-existent-plan-id",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        },
      }),
    ).rejects.toThrow();
  });

  it("queries subscriptions via Plan include", async () => {
    const app = await createTestApp(prisma);
    const team1 = await createTestTeam(prisma);
    const team2 = await createTestTeam(prisma);
    const plan = await prisma.plan.create({
      data: {
        appId: app.id,
        code: `plan-${randomSuffix()}`,
        name: "Enterprise",
      },
    });

    await prisma.teamSubscription.create({
      data: {
        teamId: team1.id,
        stripeSubscriptionId: `sub_${randomSuffix()}`,
        status: "ACTIVE",
        planId: plan.id,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });

    await prisma.teamSubscription.create({
      data: {
        teamId: team2.id,
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
    expect(result!.subscriptions).toHaveLength(2);
    expect(result!.subscriptions.every((s) => s.planId === plan.id)).toBe(true);
  });

  it("supports all TeamSubscriptionStatus values", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const plan = await prisma.plan.create({
      data: { appId: app.id, code: `plan-${randomSuffix()}`, name: "Flex" },
    });

    const statuses = [
      "ACTIVE",
      "PAST_DUE",
      "CANCELED",
      "INCOMPLETE",
      "TRIALING",
      "UNPAID",
    ] as const;

    for (const status of statuses) {
      const sub = await prisma.teamSubscription.create({
        data: {
          teamId: team.id,
          stripeSubscriptionId: `sub_${status}_${randomSuffix()}`,
          status,
          planId: plan.id,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        },
      });
      expect(sub.status).toBe(status);
    }
  });

  it("includes team and plan relations", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma, { name: "Include Team" });
    const plan = await prisma.plan.create({
      data: {
        appId: app.id,
        code: `plan-${randomSuffix()}`,
        name: "Include Test",
      },
    });

    const sub = await prisma.teamSubscription.create({
      data: {
        teamId: team.id,
        stripeSubscriptionId: `sub_${randomSuffix()}`,
        status: "ACTIVE",
        planId: plan.id,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });

    const result = await prisma.teamSubscription.findUnique({
      where: { id: sub.id },
      include: { team: true, plan: true },
    });

    expect(result).not.toBeNull();
    expect(result!.team.id).toBe(team.id);
    expect(result!.team.name).toBe("Include Team");
    expect(result!.plan.id).toBe(plan.id);
    expect(result!.plan.name).toBe("Include Test");
  });
});
