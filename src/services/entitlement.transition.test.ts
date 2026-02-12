import { describe, it, expect, vi, beforeEach } from "vitest";
import { v4 as uuidv4 } from "uuid";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    team: { findUnique: vi.fn() },
    teamSubscription: { findFirst: vi.fn() },
    contract: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    billingEntity: { findUnique: vi.fn() },
    bundle: { findUnique: vi.fn() },
    contractOverride: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

import { EntitlementService } from "./entitlement.service.js";
import { ContractService } from "./contract.service.js";

describe("Entitlement transitions on contract lifecycle", () => {
  let entitlementService: EntitlementService;
  let contractService: ContractService;

  const APP_ID = uuidv4();
  const TEAM_ID = uuidv4();
  const BILLING_ENTITY_ID = uuidv4();
  const BUNDLE_ID = uuidv4();
  const CONTRACT_ID = uuidv4();
  const PLAN_ID = uuidv4();

  function makeActiveContract(): object {
    return {
      id: CONTRACT_ID,
      billToId: BILLING_ENTITY_ID,
      status: "ACTIVE",
      bundleId: BUNDLE_ID,
      bundle: {
        id: BUNDLE_ID,
        code: "enterprise_all",
        name: "Enterprise All Apps",
        apps: [
          {
            id: uuidv4(),
            bundleId: BUNDLE_ID,
            appId: APP_ID,
            defaultFeatureFlags: { advancedAnalytics: true },
          },
        ],
        meterPolicies: [
          {
            id: uuidv4(),
            bundleId: BUNDLE_ID,
            appId: APP_ID,
            meterKey: "llm.tokens.in",
            limitType: "INCLUDED",
            includedAmount: 5000000,
            enforcement: "SOFT",
            overageBilling: "PER_UNIT",
          },
        ],
      },
      overrides: [],
    };
  }

  function mockTeam(): void {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEAM_ID,
      billingMode: "SUBSCRIPTION",
      billingEntity: { id: BILLING_ENTITY_ID },
    });
  }

  function mockSubscription(): void {
    mockPrisma.teamSubscription.findFirst.mockResolvedValue({
      id: uuidv4(),
      teamId: TEAM_ID,
      status: "ACTIVE",
      planId: PLAN_ID,
      plan: {
        id: PLAN_ID,
        appId: APP_ID,
        code: "pro",
        name: "Pro Plan",
        status: "ACTIVE",
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    entitlementService = new EntitlementService();
    contractService = new ContractService(entitlementService);
    mockTeam();
  });

  it("entitlements switch to enterprise path after contract activation", async () => {
    // Before activation: no active contract → subscription path
    mockPrisma.contract.findFirst.mockResolvedValue(null);
    mockSubscription();

    const before = await entitlementService.resolveEntitlements(APP_ID, TEAM_ID);
    expect(before.billingMode).toBe("SUBSCRIPTION");
    expect(before.planCode).toBe("pro");

    // After activation: active contract exists → enterprise path
    mockPrisma.contract.findFirst.mockResolvedValue(makeActiveContract());

    const after = await entitlementService.resolveEntitlements(APP_ID, TEAM_ID);
    expect(after.billingMode).toBe("ENTERPRISE_CONTRACT");
    expect(after.billable).toBe(true);
    expect(after.planCode).toBeNull();
    expect(after.meters["llm.tokens.in"]).toEqual({
      limitType: "INCLUDED",
      includedAmount: 5000000,
      enforcement: "SOFT",
      overageBilling: "PER_UNIT",
    });
    expect(after.features.advancedAnalytics).toBe(true);
  });

  it("entitlements revert to subscription path when contract becomes ENDED", async () => {
    // Active contract → enterprise entitlements
    mockPrisma.contract.findFirst.mockResolvedValue(makeActiveContract());

    const during = await entitlementService.resolveEntitlements(APP_ID, TEAM_ID);
    expect(during.billingMode).toBe("ENTERPRISE_CONTRACT");
    expect(during.meters["llm.tokens.in"]).toBeDefined();

    // Contract ended → no active contract → subscription path
    mockPrisma.contract.findFirst.mockResolvedValue(null);
    mockSubscription();

    const after = await entitlementService.resolveEntitlements(APP_ID, TEAM_ID);
    expect(after.billingMode).toBe("SUBSCRIPTION");
    expect(after.billable).toBe(true);
    expect(after.planCode).toBe("pro");
    expect(after.planName).toBe("Pro Plan");
    expect(after.meters).toEqual({});
    expect(after.features).toEqual({});
  });

  it("entitlements revert to defaults when contract ENDED and no subscription", async () => {
    // Active contract → enterprise entitlements
    mockPrisma.contract.findFirst.mockResolvedValue(makeActiveContract());

    const during = await entitlementService.resolveEntitlements(APP_ID, TEAM_ID);
    expect(during.billingMode).toBe("ENTERPRISE_CONTRACT");

    // Contract ended, no subscription → default entitlements
    mockPrisma.contract.findFirst.mockResolvedValue(null);
    mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

    const after = await entitlementService.resolveEntitlements(APP_ID, TEAM_ID);
    expect(after.billingMode).toBe("SUBSCRIPTION");
    expect(after.billable).toBe(false);
    expect(after.planCode).toBeNull();
    expect(after.meters).toEqual({});
    expect(after.features).toEqual({});
  });

  it("updateContract to ENDED triggers entitlement refresh", async () => {
    const refreshSpy = vi.spyOn(entitlementService, "refreshEntitlements");

    mockPrisma.contract.findUnique.mockResolvedValue({
      id: CONTRACT_ID,
      billToId: BILLING_ENTITY_ID,
      status: "ACTIVE",
      bundleId: BUNDLE_ID,
      billingEntity: {
        id: BILLING_ENTITY_ID,
        type: "TEAM",
        teamId: TEAM_ID,
        team: { id: TEAM_ID, name: "Test Team" },
      },
    });
    mockPrisma.contract.findFirst.mockResolvedValue(null);
    mockPrisma.contract.update.mockResolvedValue({
      id: CONTRACT_ID,
      billToId: BILLING_ENTITY_ID,
      status: "ENDED",
      bundleId: BUNDLE_ID,
      bundle: { id: BUNDLE_ID, code: "enterprise_all", name: "Enterprise All Apps" },
      overrides: [],
    });

    await contractService.updateContract(CONTRACT_ID, { status: "ENDED" });

    expect(refreshSpy).toHaveBeenCalledWith(TEAM_ID);
  });

  it("updateContract to ACTIVE triggers entitlement refresh", async () => {
    const refreshSpy = vi.spyOn(entitlementService, "refreshEntitlements");

    mockPrisma.contract.findUnique.mockResolvedValue({
      id: CONTRACT_ID,
      billToId: BILLING_ENTITY_ID,
      status: "DRAFT",
      bundleId: BUNDLE_ID,
      billingEntity: {
        id: BILLING_ENTITY_ID,
        type: "TEAM",
        teamId: TEAM_ID,
        team: { id: TEAM_ID, name: "Test Team" },
      },
    });
    mockPrisma.contract.findFirst.mockResolvedValue(null);
    mockPrisma.contract.update.mockResolvedValue({
      id: CONTRACT_ID,
      billToId: BILLING_ENTITY_ID,
      status: "ACTIVE",
      bundleId: BUNDLE_ID,
      bundle: { id: BUNDLE_ID, code: "enterprise_all", name: "Enterprise All Apps" },
      overrides: [],
    });

    await contractService.updateContract(CONTRACT_ID, { status: "ACTIVE" });

    expect(refreshSpy).toHaveBeenCalledWith(TEAM_ID);
  });
});
