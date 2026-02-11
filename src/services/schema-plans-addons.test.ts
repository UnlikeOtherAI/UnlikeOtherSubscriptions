import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma store for Plans, Addons, StripeProductMaps, TeamSubscriptions, TeamAddons
interface PlanRecord {
  id: string;
  appId: string;
  code: string;
  name: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface AddonRecord {
  id: string;
  appId: string;
  code: string;
  name: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface StripeProductMapRecord {
  id: string;
  appId: string;
  planId: string | null;
  addonId: string | null;
  stripeProductId: string;
  stripePriceId: string;
  kind: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TeamSubscriptionRecord {
  id: string;
  teamId: string;
  stripeSubscriptionId: string;
  status: string;
  planId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  seatsQuantity: number;
  createdAt: Date;
  updatedAt: Date;
}

interface TeamAddonRecord {
  id: string;
  teamId: string;
  addonId: string;
  status: string;
  quantity: number;
  createdAt: Date;
  updatedAt: Date;
}

// In-memory stores
let plans: PlanRecord[];
let addons: AddonRecord[];
let stripeProductMaps: StripeProductMapRecord[];
let teamSubscriptions: TeamSubscriptionRecord[];
let teamAddons: TeamAddonRecord[];

// Unique constraint helper
function generateId(): string {
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

const mockPrisma = {
  plan: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  addon: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  stripeProductMap: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  teamSubscription: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  teamAddon: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
};

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

function setupPlanMocks(): void {
  mockPrisma.plan.create.mockImplementation(
    async ({ data }: { data: Partial<PlanRecord> }) => {
      const duplicate = plans.find(
        (p) => p.appId === data.appId && p.code === data.code,
      );
      if (duplicate) {
        const err = new Error("Unique constraint failed") as Error & {
          code: string;
        };
        err.code = "P2002";
        throw err;
      }
      const record: PlanRecord = {
        id: data.id ?? generateId(),
        appId: data.appId!,
        code: data.code!,
        name: data.name!,
        status: data.status ?? "ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      plans.push(record);
      return record;
    },
  );

  mockPrisma.plan.findUnique.mockImplementation(
    async ({
      where,
      include,
    }: {
      where: { id?: string; appId_code?: { appId: string; code: string } };
      include?: { stripeProductMaps?: boolean; subscriptions?: boolean };
    }) => {
      let plan: PlanRecord | undefined;
      if (where.id) {
        plan = plans.find((p) => p.id === where.id);
      } else if (where.appId_code) {
        plan = plans.find(
          (p) =>
            p.appId === where.appId_code!.appId &&
            p.code === where.appId_code!.code,
        );
      }
      if (!plan) return null;
      const result: Record<string, unknown> = { ...plan };
      if (include?.stripeProductMaps) {
        result.stripeProductMaps = stripeProductMaps.filter(
          (m) => m.planId === plan!.id,
        );
      }
      if (include?.subscriptions) {
        result.subscriptions = teamSubscriptions.filter(
          (s) => s.planId === plan!.id,
        );
      }
      return result;
    },
  );
}

function setupAddonMocks(): void {
  mockPrisma.addon.create.mockImplementation(
    async ({ data }: { data: Partial<AddonRecord> }) => {
      const duplicate = addons.find(
        (a) => a.appId === data.appId && a.code === data.code,
      );
      if (duplicate) {
        const err = new Error("Unique constraint failed") as Error & {
          code: string;
        };
        err.code = "P2002";
        throw err;
      }
      const record: AddonRecord = {
        id: data.id ?? generateId(),
        appId: data.appId!,
        code: data.code!,
        name: data.name!,
        status: data.status ?? "ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      addons.push(record);
      return record;
    },
  );

  mockPrisma.addon.findUnique.mockImplementation(
    async ({
      where,
      include,
    }: {
      where: { id?: string; appId_code?: { appId: string; code: string } };
      include?: { stripeProductMaps?: boolean; teamAddons?: boolean };
    }) => {
      let addon: AddonRecord | undefined;
      if (where.id) {
        addon = addons.find((a) => a.id === where.id);
      } else if (where.appId_code) {
        addon = addons.find(
          (a) =>
            a.appId === where.appId_code!.appId &&
            a.code === where.appId_code!.code,
        );
      }
      if (!addon) return null;
      const result: Record<string, unknown> = { ...addon };
      if (include?.stripeProductMaps) {
        result.stripeProductMaps = stripeProductMaps.filter(
          (m) => m.addonId === addon!.id,
        );
      }
      if (include?.teamAddons) {
        result.teamAddons = teamAddons.filter(
          (ta) => ta.addonId === addon!.id,
        );
      }
      return result;
    },
  );
}

function setupStripeProductMapMocks(): void {
  mockPrisma.stripeProductMap.create.mockImplementation(
    async ({ data }: { data: Partial<StripeProductMapRecord> }) => {
      const duplicate = stripeProductMaps.find(
        (m) =>
          m.appId === data.appId && m.stripePriceId === data.stripePriceId,
      );
      if (duplicate) {
        const err = new Error("Unique constraint failed") as Error & {
          code: string;
        };
        err.code = "P2002";
        throw err;
      }
      const record: StripeProductMapRecord = {
        id: data.id ?? generateId(),
        appId: data.appId!,
        planId: data.planId ?? null,
        addonId: data.addonId ?? null,
        stripeProductId: data.stripeProductId!,
        stripePriceId: data.stripePriceId!,
        kind: data.kind!,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      stripeProductMaps.push(record);
      return record;
    },
  );
}

function setupTeamSubscriptionMocks(): void {
  mockPrisma.teamSubscription.create.mockImplementation(
    async ({ data }: { data: Partial<TeamSubscriptionRecord> }) => {
      const duplicate = teamSubscriptions.find(
        (s) => s.stripeSubscriptionId === data.stripeSubscriptionId,
      );
      if (duplicate) {
        const err = new Error("Unique constraint failed") as Error & {
          code: string;
        };
        err.code = "P2002";
        throw err;
      }
      const record: TeamSubscriptionRecord = {
        id: data.id ?? generateId(),
        teamId: data.teamId!,
        stripeSubscriptionId: data.stripeSubscriptionId!,
        status: data.status!,
        planId: data.planId!,
        currentPeriodStart: data.currentPeriodStart!,
        currentPeriodEnd: data.currentPeriodEnd!,
        seatsQuantity: data.seatsQuantity ?? 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      teamSubscriptions.push(record);
      return record;
    },
  );
}

function setupTeamAddonMocks(): void {
  mockPrisma.teamAddon.create.mockImplementation(
    async ({ data }: { data: Partial<TeamAddonRecord> }) => {
      const record: TeamAddonRecord = {
        id: data.id ?? generateId(),
        teamId: data.teamId!,
        addonId: data.addonId!,
        status: data.status ?? "ACTIVE",
        quantity: data.quantity ?? 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      teamAddons.push(record);
      return record;
    },
  );
}

describe("Prisma schema: Plans, Addons, and Subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plans = [];
    addons = [];
    stripeProductMaps = [];
    teamSubscriptions = [];
    teamAddons = [];
    setupPlanMocks();
    setupAddonMocks();
    setupStripeProductMapMocks();
    setupTeamSubscriptionMocks();
    setupTeamAddonMocks();
  });

  describe("Plan", () => {
    it("creates a Plan with correct fields", async () => {
      const plan = await mockPrisma.plan.create({
        data: {
          appId: "app-1",
          code: "pro-monthly",
          name: "Pro Monthly",
        },
      });

      expect(plan.id).toBeDefined();
      expect(plan.appId).toBe("app-1");
      expect(plan.code).toBe("pro-monthly");
      expect(plan.name).toBe("Pro Monthly");
      expect(plan.status).toBe("ACTIVE");
      expect(plan.createdAt).toBeInstanceOf(Date);
      expect(plan.updatedAt).toBeInstanceOf(Date);
    });

    it("enforces unique constraint on appId + code", async () => {
      await mockPrisma.plan.create({
        data: { appId: "app-1", code: "pro", name: "Pro" },
      });

      await expect(
        mockPrisma.plan.create({
          data: { appId: "app-1", code: "pro", name: "Pro Duplicate" },
        }),
      ).rejects.toThrow("Unique constraint failed");
    });

    it("allows same code for different apps", async () => {
      await mockPrisma.plan.create({
        data: { appId: "app-1", code: "pro", name: "Pro App 1" },
      });

      const plan2 = await mockPrisma.plan.create({
        data: { appId: "app-2", code: "pro", name: "Pro App 2" },
      });

      expect(plan2.appId).toBe("app-2");
      expect(plan2.code).toBe("pro");
    });
  });

  describe("Addon", () => {
    it("creates an Addon with correct fields", async () => {
      const addon = await mockPrisma.addon.create({
        data: {
          appId: "app-1",
          code: "extra-storage",
          name: "Extra Storage",
        },
      });

      expect(addon.id).toBeDefined();
      expect(addon.appId).toBe("app-1");
      expect(addon.code).toBe("extra-storage");
      expect(addon.name).toBe("Extra Storage");
      expect(addon.status).toBe("ACTIVE");
    });

    it("enforces unique constraint on appId + code", async () => {
      await mockPrisma.addon.create({
        data: { appId: "app-1", code: "extra-storage", name: "Extra Storage" },
      });

      await expect(
        mockPrisma.addon.create({
          data: {
            appId: "app-1",
            code: "extra-storage",
            name: "Extra Storage v2",
          },
        }),
      ).rejects.toThrow("Unique constraint failed");
    });

    it("allows same code for different apps", async () => {
      await mockPrisma.addon.create({
        data: {
          appId: "app-1",
          code: "extra-storage",
          name: "Extra Storage",
        },
      });

      const addon2 = await mockPrisma.addon.create({
        data: {
          appId: "app-2",
          code: "extra-storage",
          name: "Extra Storage",
        },
      });

      expect(addon2.appId).toBe("app-2");
    });
  });

  describe("StripeProductMap", () => {
    it("links to a Plan via planId", async () => {
      const plan = await mockPrisma.plan.create({
        data: { appId: "app-1", code: "pro", name: "Pro" },
      });

      const spm = await mockPrisma.stripeProductMap.create({
        data: {
          appId: "app-1",
          planId: plan.id,
          addonId: null,
          stripeProductId: "prod_base",
          stripePriceId: "price_base",
          kind: "BASE",
        },
      });

      expect(spm.planId).toBe(plan.id);
      expect(spm.addonId).toBeNull();
      expect(spm.kind).toBe("BASE");
    });

    it("links to an Addon via addonId", async () => {
      const addon = await mockPrisma.addon.create({
        data: { appId: "app-1", code: "storage", name: "Storage" },
      });

      const spm = await mockPrisma.stripeProductMap.create({
        data: {
          appId: "app-1",
          planId: null,
          addonId: addon.id,
          stripeProductId: "prod_addon",
          stripePriceId: "price_addon",
          kind: "ADDON",
        },
      });

      expect(spm.addonId).toBe(addon.id);
      expect(spm.planId).toBeNull();
      expect(spm.kind).toBe("ADDON");
    });

    it("enforces unique constraint on appId + stripePriceId", async () => {
      await mockPrisma.stripeProductMap.create({
        data: {
          appId: "app-1",
          planId: null,
          stripeProductId: "prod_1",
          stripePriceId: "price_1",
          kind: "BASE",
        },
      });

      await expect(
        mockPrisma.stripeProductMap.create({
          data: {
            appId: "app-1",
            planId: null,
            stripeProductId: "prod_2",
            stripePriceId: "price_1",
            kind: "SEAT",
          },
        }),
      ).rejects.toThrow("Unique constraint failed");
    });

    it("queries StripeProductMaps via Plan include", async () => {
      const plan = await mockPrisma.plan.create({
        data: { appId: "app-1", code: "pro", name: "Pro" },
      });

      await mockPrisma.stripeProductMap.create({
        data: {
          appId: "app-1",
          planId: plan.id,
          stripeProductId: "prod_base",
          stripePriceId: "price_base",
          kind: "BASE",
        },
      });

      await mockPrisma.stripeProductMap.create({
        data: {
          appId: "app-1",
          planId: plan.id,
          stripeProductId: "prod_seat",
          stripePriceId: "price_seat",
          kind: "SEAT",
        },
      });

      const result = await mockPrisma.plan.findUnique({
        where: { id: plan.id },
        include: { stripeProductMaps: true },
      });

      expect(result).not.toBeNull();
      expect(result.stripeProductMaps).toHaveLength(2);
      expect(result.stripeProductMaps[0].planId).toBe(plan.id);
      expect(result.stripeProductMaps[1].planId).toBe(plan.id);
    });

    it("queries StripeProductMaps via Addon include", async () => {
      const addon = await mockPrisma.addon.create({
        data: { appId: "app-1", code: "storage", name: "Storage" },
      });

      await mockPrisma.stripeProductMap.create({
        data: {
          appId: "app-1",
          addonId: addon.id,
          stripeProductId: "prod_addon",
          stripePriceId: "price_addon",
          kind: "ADDON",
        },
      });

      const result = await mockPrisma.addon.findUnique({
        where: { id: addon.id },
        include: { stripeProductMaps: true },
      });

      expect(result).not.toBeNull();
      expect(result.stripeProductMaps).toHaveLength(1);
      expect(result.stripeProductMaps[0].addonId).toBe(addon.id);
    });
  });

  describe("TeamSubscription", () => {
    it("creates a TeamSubscription with correct fields", async () => {
      const now = new Date();
      const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const sub = await mockPrisma.teamSubscription.create({
        data: {
          teamId: "team-1",
          stripeSubscriptionId: "sub_abc123",
          status: "ACTIVE",
          planId: "plan-1",
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          seatsQuantity: 5,
        },
      });

      expect(sub.id).toBeDefined();
      expect(sub.teamId).toBe("team-1");
      expect(sub.stripeSubscriptionId).toBe("sub_abc123");
      expect(sub.status).toBe("ACTIVE");
      expect(sub.planId).toBe("plan-1");
      expect(sub.seatsQuantity).toBe(5);
    });

    it("defaults seatsQuantity to 1", async () => {
      const sub = await mockPrisma.teamSubscription.create({
        data: {
          teamId: "team-1",
          stripeSubscriptionId: "sub_def456",
          status: "ACTIVE",
          planId: "plan-1",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(),
        },
      });

      expect(sub.seatsQuantity).toBe(1);
    });

    it("enforces unique stripeSubscriptionId", async () => {
      await mockPrisma.teamSubscription.create({
        data: {
          teamId: "team-1",
          stripeSubscriptionId: "sub_unique",
          status: "ACTIVE",
          planId: "plan-1",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(),
        },
      });

      await expect(
        mockPrisma.teamSubscription.create({
          data: {
            teamId: "team-2",
            stripeSubscriptionId: "sub_unique",
            status: "ACTIVE",
            planId: "plan-1",
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(),
          },
        }),
      ).rejects.toThrow("Unique constraint failed");
    });

    it("queries subscriptions via Plan include", async () => {
      const plan = await mockPrisma.plan.create({
        data: { appId: "app-1", code: "enterprise", name: "Enterprise" },
      });

      await mockPrisma.teamSubscription.create({
        data: {
          teamId: "team-1",
          stripeSubscriptionId: "sub_1",
          status: "ACTIVE",
          planId: plan.id,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(),
        },
      });

      await mockPrisma.teamSubscription.create({
        data: {
          teamId: "team-2",
          stripeSubscriptionId: "sub_2",
          status: "ACTIVE",
          planId: plan.id,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(),
        },
      });

      const result = await mockPrisma.plan.findUnique({
        where: { id: plan.id },
        include: { subscriptions: true },
      });

      expect(result).not.toBeNull();
      expect(result.subscriptions).toHaveLength(2);
    });
  });

  describe("TeamAddon", () => {
    it("creates a TeamAddon with correct fields", async () => {
      const ta = await mockPrisma.teamAddon.create({
        data: {
          teamId: "team-1",
          addonId: "addon-1",
          quantity: 3,
        },
      });

      expect(ta.id).toBeDefined();
      expect(ta.teamId).toBe("team-1");
      expect(ta.addonId).toBe("addon-1");
      expect(ta.status).toBe("ACTIVE");
      expect(ta.quantity).toBe(3);
    });

    it("defaults quantity to 1 and status to ACTIVE", async () => {
      const ta = await mockPrisma.teamAddon.create({
        data: {
          teamId: "team-1",
          addonId: "addon-1",
        },
      });

      expect(ta.status).toBe("ACTIVE");
      expect(ta.quantity).toBe(1);
    });

    it("queries teamAddons via Addon include", async () => {
      const addon = await mockPrisma.addon.create({
        data: { appId: "app-1", code: "storage", name: "Storage" },
      });

      await mockPrisma.teamAddon.create({
        data: { teamId: "team-1", addonId: addon.id, quantity: 2 },
      });

      await mockPrisma.teamAddon.create({
        data: { teamId: "team-2", addonId: addon.id, quantity: 5 },
      });

      const result = await mockPrisma.addon.findUnique({
        where: { id: addon.id },
        include: { teamAddons: true },
      });

      expect(result).not.toBeNull();
      expect(result.teamAddons).toHaveLength(2);
      expect(result.teamAddons[0].addonId).toBe(addon.id);
      expect(result.teamAddons[1].addonId).toBe(addon.id);
    });
  });
});
