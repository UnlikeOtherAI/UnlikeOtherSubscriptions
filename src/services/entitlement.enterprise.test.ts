import { describe, it, expect, vi, beforeEach } from "vitest";
import { v4 as uuidv4 } from "uuid";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    team: { findUnique: vi.fn() },
    teamSubscription: { findFirst: vi.fn() },
    contract: { findFirst: vi.fn() },
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

import { EntitlementService } from "./entitlement.service.js";

describe("EntitlementService — enterprise contract path", () => {
  let service: EntitlementService;

  const APP_ID = uuidv4();
  const TEAM_ID = uuidv4();
  const PLAN_ID = uuidv4();
  const BILLING_ENTITY_ID = uuidv4();
  const BUNDLE_ID = uuidv4();
  const CONTRACT_ID = uuidv4();

  beforeEach(() => {
    vi.clearAllMocks();
    service = new EntitlementService();
    mockPrisma.contract.findFirst.mockResolvedValue(null);
  });

  function mockTeamWithBillingEntity(): void {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEAM_ID,
      billingMode: "SUBSCRIPTION",
      billingEntity: { id: BILLING_ENTITY_ID },
    });
  }

  function makeContract(overrides: {
    apps?: Array<{ appId: string; defaultFeatureFlags?: unknown }>;
    meterPolicies?: Array<{
      meterKey: string;
      limitType: string;
      includedAmount?: number | null;
      enforcement?: string;
      overageBilling?: string;
    }>;
    contractOverrides?: Array<{
      meterKey: string;
      limitType?: string | null;
      includedAmount?: number | null;
      enforcement?: string | null;
      overageBilling?: string | null;
      featureFlags?: unknown;
    }>;
  }): object {
    return {
      id: CONTRACT_ID,
      billToId: BILLING_ENTITY_ID,
      status: "ACTIVE",
      bundleId: BUNDLE_ID,
      bundle: {
        id: BUNDLE_ID,
        code: "enterprise_all",
        name: "Enterprise All Apps",
        apps: (overrides.apps ?? [{ appId: APP_ID }]).map((a) => ({
          id: uuidv4(),
          bundleId: BUNDLE_ID,
          appId: a.appId,
          defaultFeatureFlags: a.defaultFeatureFlags ?? null,
        })),
        meterPolicies: (overrides.meterPolicies ?? []).map((mp) => ({
          id: uuidv4(),
          bundleId: BUNDLE_ID,
          appId: APP_ID,
          meterKey: mp.meterKey,
          limitType: mp.limitType,
          includedAmount: mp.includedAmount ?? null,
          enforcement: mp.enforcement ?? "NONE",
          overageBilling: mp.overageBilling ?? "NONE",
        })),
      },
      overrides: (overrides.contractOverrides ?? []).map((co) => ({
        id: uuidv4(),
        contractId: CONTRACT_ID,
        appId: APP_ID,
        meterKey: co.meterKey,
        limitType: co.limitType ?? null,
        includedAmount: co.includedAmount ?? null,
        enforcement: co.enforcement ?? null,
        overageBilling: co.overageBilling ?? null,
        featureFlags: co.featureFlags ?? null,
      })),
    };
  }

  it("returns enterprise entitlements for team with active contract", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(
      makeContract({
        meterPolicies: [
          {
            meterKey: "llm.tokens.in",
            limitType: "INCLUDED",
            includedAmount: 1000000,
            enforcement: "SOFT",
            overageBilling: "PER_UNIT",
          },
        ],
      }),
    );

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.billingMode).toBe("ENTERPRISE_CONTRACT");
    expect(result.billable).toBe(true);
    expect(result.planCode).toBeNull();
    expect(result.planName).toBeNull();
    expect(result.meters["llm.tokens.in"]).toEqual({
      limitType: "INCLUDED",
      includedAmount: 1000000,
      enforcement: "SOFT",
      overageBilling: "PER_UNIT",
    });
  });

  it("ContractOverride takes priority over BundleMeterPolicy", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(
      makeContract({
        meterPolicies: [
          {
            meterKey: "llm.tokens.in",
            limitType: "INCLUDED",
            includedAmount: 1000000,
            enforcement: "SOFT",
            overageBilling: "PER_UNIT",
          },
        ],
        contractOverrides: [
          {
            meterKey: "llm.tokens.in",
            limitType: "HARD_CAP",
            includedAmount: 5000000,
            enforcement: "HARD",
            overageBilling: "TIERED",
          },
        ],
      }),
    );

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.meters["llm.tokens.in"]).toEqual({
      limitType: "HARD_CAP",
      includedAmount: 5000000,
      enforcement: "HARD",
      overageBilling: "TIERED",
    });
  });

  it("BundleMeterPolicy takes priority over defaults", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(
      makeContract({
        meterPolicies: [
          {
            meterKey: "storage.bytes",
            limitType: "HARD_CAP",
            includedAmount: 5000,
            enforcement: "HARD",
            overageBilling: "TIERED",
          },
        ],
      }),
    );

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.meters["storage.bytes"]).toEqual({
      limitType: "HARD_CAP",
      includedAmount: 5000,
      enforcement: "HARD",
      overageBilling: "TIERED",
    });
  });

  it("UNLIMITED limitType is correctly represented", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(
      makeContract({
        meterPolicies: [
          {
            meterKey: "llm.tokens.in",
            limitType: "UNLIMITED",
            enforcement: "NONE",
            overageBilling: "NONE",
          },
        ],
      }),
    );

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.meters["llm.tokens.in"].limitType).toBe("UNLIMITED");
    expect(result.meters["llm.tokens.in"].includedAmount).toBeNull();
  });

  it("sets billingMode to ENTERPRISE_CONTRACT", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(makeContract({}));

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.billingMode).toBe("ENTERPRISE_CONTRACT");
  });

  it("falls back to plan-based resolution when contract is PAUSED", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(null);
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

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.billingMode).toBe("SUBSCRIPTION");
    expect(result.billable).toBe(true);
    expect(result.planCode).toBe("pro");
  });

  it("returns default entitlements when app is not in the bundle", async () => {
    mockTeamWithBillingEntity();
    const differentAppId = uuidv4();
    mockPrisma.contract.findFirst.mockResolvedValue(
      makeContract({
        apps: [{ appId: differentAppId }],
      }),
    );

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.billingMode).toBe("SUBSCRIPTION");
    expect(result.billable).toBe(false);
    expect(result.features).toEqual({});
    expect(result.meters).toEqual({});
  });

  it("merges feature flags from BundleApp defaults", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(
      makeContract({
        apps: [
          {
            appId: APP_ID,
            defaultFeatureFlags: { advancedAnalytics: true, betaAccess: false },
          },
        ],
      }),
    );

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.features.advancedAnalytics).toBe(true);
    expect(result.features.betaAccess).toBe(false);
  });

  it("ContractOverride feature flags override BundleApp defaults", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(
      makeContract({
        apps: [
          {
            appId: APP_ID,
            defaultFeatureFlags: { advancedAnalytics: false, betaAccess: false },
          },
        ],
        contractOverrides: [
          {
            meterKey: "llm.tokens.in",
            featureFlags: { advancedAnalytics: true },
          },
        ],
      }),
    );

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.features.advancedAnalytics).toBe(true);
    expect(result.features.betaAccess).toBe(false);
  });

  it("handles ContractOverride for meter not in BundleMeterPolicy", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(
      makeContract({
        meterPolicies: [],
        contractOverrides: [
          {
            meterKey: "custom.meter",
            limitType: "INCLUDED",
            includedAmount: 500,
            enforcement: "HARD",
            overageBilling: "PER_UNIT",
          },
        ],
      }),
    );

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.meters["custom.meter"]).toEqual({
      limitType: "INCLUDED",
      includedAmount: 500,
      enforcement: "HARD",
      overageBilling: "PER_UNIT",
    });
  });

  it("partial ContractOverride falls back to BundleMeterPolicy for unset fields", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(
      makeContract({
        meterPolicies: [
          {
            meterKey: "llm.tokens.in",
            limitType: "INCLUDED",
            includedAmount: 1000000,
            enforcement: "SOFT",
            overageBilling: "PER_UNIT",
          },
        ],
        contractOverrides: [
          {
            meterKey: "llm.tokens.in",
            limitType: "UNLIMITED",
          },
        ],
      }),
    );

    const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(result.meters["llm.tokens.in"]).toEqual({
      limitType: "UNLIMITED",
      includedAmount: 1000000,
      enforcement: "SOFT",
      overageBilling: "PER_UNIT",
    });
  });

  it("does not query subscriptions when an active contract exists", async () => {
    mockTeamWithBillingEntity();
    mockPrisma.contract.findFirst.mockResolvedValue(makeContract({}));

    await service.resolveEntitlements(APP_ID, TEAM_ID);

    expect(mockPrisma.teamSubscription.findFirst).not.toHaveBeenCalled();
  });
});
