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

describe("TeamAddon integration", () => {
  it("creates a TeamAddon with correct fields", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const addon = await prisma.addon.create({
      data: {
        appId: app.id,
        code: `addon-${randomSuffix()}`,
        name: "Extra Storage",
      },
    });

    const ta = await prisma.teamAddon.create({
      data: {
        teamId: team.id,
        addonId: addon.id,
        quantity: 3,
      },
    });

    expect(ta.id).toBeDefined();
    expect(ta.teamId).toBe(team.id);
    expect(ta.addonId).toBe(addon.id);
    expect(ta.status).toBe("ACTIVE");
    expect(ta.quantity).toBe(3);
    expect(ta.createdAt).toBeInstanceOf(Date);
    expect(ta.updatedAt).toBeInstanceOf(Date);
  });

  it("defaults quantity to 1 and status to ACTIVE", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);
    const addon = await prisma.addon.create({
      data: {
        appId: app.id,
        code: `addon-${randomSuffix()}`,
        name: "Feature X",
      },
    });

    const ta = await prisma.teamAddon.create({
      data: {
        teamId: team.id,
        addonId: addon.id,
      },
    });

    expect(ta.status).toBe("ACTIVE");
    expect(ta.quantity).toBe(1);
  });

  it("enforces FK to Team — rejects invalid teamId", async () => {
    const app = await createTestApp(prisma);
    const addon = await prisma.addon.create({
      data: {
        appId: app.id,
        code: `addon-${randomSuffix()}`,
        name: "Feature Y",
      },
    });

    await expect(
      prisma.teamAddon.create({
        data: {
          teamId: "non-existent-team-id",
          addonId: addon.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to Addon — rejects invalid addonId", async () => {
    const team = await createTestTeam(prisma);

    await expect(
      prisma.teamAddon.create({
        data: {
          teamId: team.id,
          addonId: "non-existent-addon-id",
        },
      }),
    ).rejects.toThrow();
  });

  it("queries teamAddons via Addon include", async () => {
    const app = await createTestApp(prisma);
    const team1 = await createTestTeam(prisma);
    const team2 = await createTestTeam(prisma);
    const addon = await prisma.addon.create({
      data: {
        appId: app.id,
        code: `addon-${randomSuffix()}`,
        name: "Storage",
      },
    });

    await prisma.teamAddon.create({
      data: { teamId: team1.id, addonId: addon.id, quantity: 2 },
    });

    await prisma.teamAddon.create({
      data: { teamId: team2.id, addonId: addon.id, quantity: 5 },
    });

    const result = await prisma.addon.findUnique({
      where: { id: addon.id },
      include: { teamAddons: true },
    });

    expect(result).not.toBeNull();
    expect(result!.teamAddons).toHaveLength(2);
    expect(result!.teamAddons[0].addonId).toBe(addon.id);
    expect(result!.teamAddons[1].addonId).toBe(addon.id);
  });

  it("includes team and addon relations", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma, { name: "Include Team" });
    const addon = await prisma.addon.create({
      data: {
        appId: app.id,
        code: `addon-${randomSuffix()}`,
        name: "Include Test",
      },
    });

    const ta = await prisma.teamAddon.create({
      data: {
        teamId: team.id,
        addonId: addon.id,
        quantity: 10,
      },
    });

    const result = await prisma.teamAddon.findUnique({
      where: { id: ta.id },
      include: { team: true, addon: true },
    });

    expect(result).not.toBeNull();
    expect(result!.team.id).toBe(team.id);
    expect(result!.team.name).toBe("Include Team");
    expect(result!.addon.id).toBe(addon.id);
    expect(result!.addon.name).toBe("Include Test");
  });

  it("allows multiple addons per team", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma);

    const addon1 = await prisma.addon.create({
      data: {
        appId: app.id,
        code: `addon-1-${randomSuffix()}`,
        name: "Storage",
      },
    });

    const addon2 = await prisma.addon.create({
      data: {
        appId: app.id,
        code: `addon-2-${randomSuffix()}`,
        name: "Bandwidth",
      },
    });

    await prisma.teamAddon.create({
      data: { teamId: team.id, addonId: addon1.id, quantity: 2 },
    });

    await prisma.teamAddon.create({
      data: { teamId: team.id, addonId: addon2.id, quantity: 3 },
    });

    const teamAddons = await prisma.teamAddon.findMany({
      where: { teamId: team.id },
    });

    expect(teamAddons).toHaveLength(2);
  });

  it("queries team addons via Team include", async () => {
    const app = await createTestApp(prisma);
    const team = await createTestTeam(prisma, { name: "Addon Team" });
    const addon = await prisma.addon.create({
      data: {
        appId: app.id,
        code: `addon-${randomSuffix()}`,
        name: "Premium",
      },
    });

    await prisma.teamAddon.create({
      data: { teamId: team.id, addonId: addon.id, quantity: 1 },
    });

    const result = await prisma.team.findUnique({
      where: { id: team.id },
      include: { teamAddons: true },
    });

    expect(result).not.toBeNull();
    expect(result!.teamAddons).toHaveLength(1);
    expect(result!.teamAddons[0].teamId).toBe(team.id);
  });
});
