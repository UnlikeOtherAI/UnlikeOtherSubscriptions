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

describe("Addon integration", () => {
  it("creates an Addon with correct fields and defaults", async () => {
    const app = await createTestApp(prisma);
    const code = `addon-${randomSuffix()}`;

    const addon = await prisma.addon.create({
      data: { appId: app.id, code, name: "Extra Storage" },
    });

    expect(addon.id).toBeDefined();
    expect(addon.appId).toBe(app.id);
    expect(addon.code).toBe(code);
    expect(addon.name).toBe("Extra Storage");
    expect(addon.status).toBe("ACTIVE");
    expect(addon.createdAt).toBeInstanceOf(Date);
    expect(addon.updatedAt).toBeInstanceOf(Date);
  });

  it("enforces unique constraint on appId + code", async () => {
    const app = await createTestApp(prisma);
    const code = `uniq-${randomSuffix()}`;

    await prisma.addon.create({
      data: { appId: app.id, code, name: "Extra Storage" },
    });

    await expect(
      prisma.addon.create({
        data: { appId: app.id, code, name: "Extra Storage v2" },
      }),
    ).rejects.toThrow();
  });

  it("allows same code for different apps", async () => {
    const app1 = await createTestApp(prisma);
    const app2 = await createTestApp(prisma);
    const code = `shared-${randomSuffix()}`;

    const addon1 = await prisma.addon.create({
      data: { appId: app1.id, code, name: "Extra Storage" },
    });

    const addon2 = await prisma.addon.create({
      data: { appId: app2.id, code, name: "Extra Storage" },
    });

    expect(addon1.appId).toBe(app1.id);
    expect(addon2.appId).toBe(app2.id);
  });

  it("enforces FK to App — rejects invalid appId", async () => {
    await expect(
      prisma.addon.create({
        data: {
          appId: "non-existent-app-id",
          code: `fk-${randomSuffix()}`,
          name: "Extra Storage",
        },
      }),
    ).rejects.toThrow();
  });

  it("looks up Addon by composite unique appId_code", async () => {
    const app = await createTestApp(prisma);
    const code = `lookup-${randomSuffix()}`;

    const created = await prisma.addon.create({
      data: { appId: app.id, code, name: "Extra Seats" },
    });

    const found = await prisma.addon.findUnique({
      where: { appId_code: { appId: app.id, code } },
    });

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("includes stripeProductMaps via Addon.include", async () => {
    const app = await createTestApp(prisma);
    const code = `incl-spm-${randomSuffix()}`;

    const addon = await prisma.addon.create({
      data: { appId: app.id, code, name: "Storage" },
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

  it("includes teamAddons via Addon.include", async () => {
    const app = await createTestApp(prisma);
    const team1 = await createTestTeam(prisma);
    const team2 = await createTestTeam(prisma);
    const code = `incl-ta-${randomSuffix()}`;

    const addon = await prisma.addon.create({
      data: { appId: app.id, code, name: "Storage" },
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
});
