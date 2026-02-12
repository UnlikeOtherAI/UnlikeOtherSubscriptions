import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getTestPrisma,
  disconnectTestPrisma,
  createTestApp,
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

describe("Bundle integration", () => {
  it("creates a Bundle with correct fields and defaults", async () => {
    const bundle = await createTestBundle(prisma);

    expect(bundle.id).toBeDefined();
    expect(bundle.code).toBeDefined();
    expect(bundle.name).toBe("Test Bundle");
  });

  it("enforces unique constraint on code", async () => {
    const code = `uniq-${randomSuffix()}`;
    await prisma.bundle.create({
      data: { code, name: "Bundle A" },
    });

    await expect(
      prisma.bundle.create({
        data: { code, name: "Bundle B" },
      }),
    ).rejects.toThrow();
  });

  it("defaults status to ACTIVE", async () => {
    const bundle = await prisma.bundle.create({
      data: { code: `status-${randomSuffix()}`, name: "Status Test" },
    });

    expect(bundle.status).toBe("ACTIVE");
  });
});

describe("BundleApp integration", () => {
  it("creates a BundleApp linking Bundle and App", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);

    const bundleApp = await prisma.bundleApp.create({
      data: { bundleId: bundle.id, appId: app.id },
    });

    expect(bundleApp.id).toBeDefined();
    expect(bundleApp.bundleId).toBe(bundle.id);
    expect(bundleApp.appId).toBe(app.id);
    expect(bundleApp.defaultFeatureFlags).toBeNull();
  });

  it("stores defaultFeatureFlags as JSONB", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);
    const flags = { advancedAnalytics: true, customBranding: true };

    const bundleApp = await prisma.bundleApp.create({
      data: {
        bundleId: bundle.id,
        appId: app.id,
        defaultFeatureFlags: flags,
      },
    });

    expect(bundleApp.defaultFeatureFlags).toEqual(flags);
  });

  it("enforces unique constraint on bundleId + appId", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);

    await prisma.bundleApp.create({
      data: { bundleId: bundle.id, appId: app.id },
    });

    await expect(
      prisma.bundleApp.create({
        data: { bundleId: bundle.id, appId: app.id },
      }),
    ).rejects.toThrow();
  });

  it("allows same app in different bundles", async () => {
    const app = await createTestApp(prisma);
    const bundle1 = await createTestBundle(prisma);
    const bundle2 = await createTestBundle(prisma);

    const ba1 = await prisma.bundleApp.create({
      data: { bundleId: bundle1.id, appId: app.id },
    });
    const ba2 = await prisma.bundleApp.create({
      data: { bundleId: bundle2.id, appId: app.id },
    });

    expect(ba1.bundleId).toBe(bundle1.id);
    expect(ba2.bundleId).toBe(bundle2.id);
  });

  it("enforces FK to Bundle — rejects invalid bundleId", async () => {
    const app = await createTestApp(prisma);

    await expect(
      prisma.bundleApp.create({
        data: { bundleId: "non-existent-bundle", appId: app.id },
      }),
    ).rejects.toThrow();
  });

  it("enforces FK to App — rejects invalid appId", async () => {
    const bundle = await createTestBundle(prisma);

    await expect(
      prisma.bundleApp.create({
        data: { bundleId: bundle.id, appId: "non-existent-app" },
      }),
    ).rejects.toThrow();
  });

  it("includes apps via Bundle.include", async () => {
    const app1 = await createTestApp(prisma);
    const app2 = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);

    await prisma.bundleApp.create({
      data: { bundleId: bundle.id, appId: app1.id },
    });
    await prisma.bundleApp.create({
      data: { bundleId: bundle.id, appId: app2.id },
    });

    const result = await prisma.bundle.findUnique({
      where: { id: bundle.id },
      include: { apps: true },
    });

    expect(result).not.toBeNull();
    expect(result!.apps).toHaveLength(2);
  });
});

describe("BundleMeterPolicy integration", () => {
  it("creates a BundleMeterPolicy with all fields", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);

    const policy = await prisma.bundleMeterPolicy.create({
      data: {
        bundleId: bundle.id,
        appId: app.id,
        meterKey: "llm.tokens.in",
        limitType: "INCLUDED",
        includedAmount: 1000000,
        enforcement: "SOFT",
        overageBilling: "PER_UNIT",
        notes: "1M tokens included",
      },
    });

    expect(policy.id).toBeDefined();
    expect(policy.limitType).toBe("INCLUDED");
    expect(policy.includedAmount).toBe(1000000);
    expect(policy.enforcement).toBe("SOFT");
    expect(policy.overageBilling).toBe("PER_UNIT");
    expect(policy.notes).toBe("1M tokens included");
  });

  it("enforces unique constraint on bundleId + appId + meterKey", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);

    await prisma.bundleMeterPolicy.create({
      data: {
        bundleId: bundle.id,
        appId: app.id,
        meterKey: "storage.bytes",
        limitType: "UNLIMITED",
      },
    });

    await expect(
      prisma.bundleMeterPolicy.create({
        data: {
          bundleId: bundle.id,
          appId: app.id,
          meterKey: "storage.bytes",
          limitType: "HARD_CAP",
        },
      }),
    ).rejects.toThrow();
  });

  it("allows same meterKey for different bundles", async () => {
    const app = await createTestApp(prisma);
    const bundle1 = await createTestBundle(prisma);
    const bundle2 = await createTestBundle(prisma);

    const p1 = await prisma.bundleMeterPolicy.create({
      data: {
        bundleId: bundle1.id,
        appId: app.id,
        meterKey: "llm.image",
        limitType: "INCLUDED",
        includedAmount: 100,
      },
    });
    const p2 = await prisma.bundleMeterPolicy.create({
      data: {
        bundleId: bundle2.id,
        appId: app.id,
        meterKey: "llm.image",
        limitType: "UNLIMITED",
      },
    });

    expect(p1.bundleId).toBe(bundle1.id);
    expect(p2.bundleId).toBe(bundle2.id);
  });

  it("defaults enforcement and overageBilling to NONE", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);

    const policy = await prisma.bundleMeterPolicy.create({
      data: {
        bundleId: bundle.id,
        appId: app.id,
        meterKey: "bandwidth.out",
        limitType: "NONE",
      },
    });

    expect(policy.enforcement).toBe("NONE");
    expect(policy.overageBilling).toBe("NONE");
  });

  it("includes meterPolicies via Bundle.include", async () => {
    const app = await createTestApp(prisma);
    const bundle = await createTestBundle(prisma);

    await prisma.bundleMeterPolicy.create({
      data: {
        bundleId: bundle.id,
        appId: app.id,
        meterKey: "llm.tokens.in",
        limitType: "INCLUDED",
        includedAmount: 500000,
      },
    });
    await prisma.bundleMeterPolicy.create({
      data: {
        bundleId: bundle.id,
        appId: app.id,
        meterKey: "llm.tokens.out",
        limitType: "INCLUDED",
        includedAmount: 200000,
      },
    });

    const result = await prisma.bundle.findUnique({
      where: { id: bundle.id },
      include: { meterPolicies: true },
    });

    expect(result).not.toBeNull();
    expect(result!.meterPolicies).toHaveLength(2);
  });
});
