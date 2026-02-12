import { getPrismaClient } from "../lib/prisma.js";

export interface MeterPolicy {
  limitType: "NONE" | "INCLUDED" | "UNLIMITED" | "HARD_CAP";
  includedAmount: number | null;
  enforcement: "NONE" | "SOFT" | "HARD";
  overageBilling: "NONE" | "PER_UNIT" | "TIERED" | "CUSTOM";
}

export interface EntitlementResult {
  features: Record<string, boolean>;
  meters: Record<string, MeterPolicy>;
  billingMode: string;
  billable: boolean;
  planCode: string | null;
  planName: string | null;
}

const DEFAULT_METER_POLICY: MeterPolicy = {
  limitType: "NONE",
  includedAmount: null,
  enforcement: "NONE",
  overageBilling: "NONE",
};

const DEFAULT_ENTITLEMENTS: EntitlementResult = {
  features: {},
  meters: {},
  billingMode: "SUBSCRIPTION",
  billable: false,
  planCode: null,
  planName: null,
};

export class EntitlementService {
  /**
   * Resolve entitlements for a team within a specific app.
   *
   * Algorithm:
   * 1. Look up the team's BillingEntity
   * 2. Check for an ACTIVE contract on that billing entity
   * 3. If active contract exists: resolve via enterprise path (bundle + overrides)
   * 4. If no active contract: resolve via per-app subscription plan
   */
  async resolveEntitlements(
    appId: string,
    teamId: string,
  ): Promise<EntitlementResult> {
    const prisma = getPrismaClient();

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { billingEntity: true },
    });

    if (!team) {
      throw new TeamNotFoundError(teamId);
    }

    // Check for an ACTIVE contract on this team's billing entity
    if (team.billingEntity) {
      const activeContract = await prisma.contract.findFirst({
        where: {
          billToId: team.billingEntity.id,
          status: "ACTIVE",
        },
        include: {
          bundle: {
            include: {
              apps: true,
              meterPolicies: { where: { appId } },
            },
          },
          overrides: { where: { appId } },
        },
      });

      if (activeContract) {
        return this.resolveEnterpriseEntitlements(
          appId,
          activeContract,
        );
      }
    }

    // No active contract — resolve via per-app subscription plan
    return this.resolveSubscriptionEntitlements(appId, teamId, team.billingMode);
  }

  /**
   * Resolve entitlements via the enterprise contract path.
   *
   * Priority cascade (highest wins):
   * 1. ContractOverride (per-app + per-meter on the contract)
   * 2. BundleMeterPolicy (defaults from the contract's bundle)
   * 3. Defaults (system-wide fallback)
   */
  private resolveEnterpriseEntitlements(
    appId: string,
    contract: ContractWithRelations,
  ): EntitlementResult {
    const bundleApp = contract.bundle.apps.find(
      (ba) => ba.appId === appId,
    );

    // App not in the bundle — return default entitlements
    if (!bundleApp) {
      return { ...DEFAULT_ENTITLEMENTS };
    }

    // Merge feature flags from BundleApp defaults and ContractOverride flags
    const features: Record<string, boolean> = {};
    if (bundleApp.defaultFeatureFlags && typeof bundleApp.defaultFeatureFlags === "object") {
      const flags = bundleApp.defaultFeatureFlags as Record<string, boolean>;
      for (const [key, value] of Object.entries(flags)) {
        if (typeof value === "boolean") {
          features[key] = value;
        }
      }
    }

    // Merge meter policies: BundleMeterPolicy as base, ContractOverride wins
    const meters: Record<string, MeterPolicy> = {};
    const bundlePolicies = contract.bundle.meterPolicies;
    const overrides = contract.overrides;

    // Build a set of all meter keys from both sources
    const meterKeys = new Set<string>();
    for (const bp of bundlePolicies) {
      meterKeys.add(bp.meterKey);
    }
    for (const ov of overrides) {
      meterKeys.add(ov.meterKey);
      // Apply override feature flags
      if (ov.featureFlags && typeof ov.featureFlags === "object") {
        const flags = ov.featureFlags as Record<string, boolean>;
        for (const [key, value] of Object.entries(flags)) {
          if (typeof value === "boolean") {
            features[key] = value;
          }
        }
      }
    }

    for (const meterKey of meterKeys) {
      const bundlePolicy = bundlePolicies.find(
        (bp) => bp.meterKey === meterKey,
      );
      const override = overrides.find(
        (ov) => ov.meterKey === meterKey,
      );

      // Start with defaults, layer bundle policy, then override
      const base: MeterPolicy = bundlePolicy
        ? {
            limitType: bundlePolicy.limitType,
            includedAmount: bundlePolicy.includedAmount,
            enforcement: bundlePolicy.enforcement,
            overageBilling: bundlePolicy.overageBilling,
          }
        : { ...DEFAULT_METER_POLICY };

      meters[meterKey] = {
        limitType: override?.limitType ?? base.limitType,
        includedAmount: override?.includedAmount ?? base.includedAmount,
        enforcement: override?.enforcement ?? base.enforcement,
        overageBilling: override?.overageBilling ?? base.overageBilling,
      };
    }

    return {
      features,
      meters,
      billingMode: "ENTERPRISE_CONTRACT",
      billable: true,
      planCode: null,
      planName: null,
    };
  }

  /**
   * Resolve entitlements via per-app subscription plan (non-enterprise path).
   */
  private async resolveSubscriptionEntitlements(
    appId: string,
    teamId: string,
    billingMode: string,
  ): Promise<EntitlementResult> {
    const prisma = getPrismaClient();

    const activeSubscription = await prisma.teamSubscription.findFirst({
      where: {
        teamId,
        status: "ACTIVE",
        plan: { appId },
      },
      include: { plan: true },
    });

    if (!activeSubscription) {
      return {
        ...DEFAULT_ENTITLEMENTS,
        billingMode,
      };
    }

    return {
      features: {},
      meters: {},
      billingMode,
      billable: true,
      planCode: activeSubscription.plan.code,
      planName: activeSubscription.plan.name,
    };
  }

  /**
   * Recompute entitlements for a team after a subscription state change.
   * In V1, this is a no-op — entitlement resolution happens on-demand
   * via GET /entitlements.
   */
  async refreshEntitlements(teamId: string): Promise<void> {
    void teamId;
  }
}

/** Type for contract with included bundle relations */
interface ContractWithRelations {
  bundle: {
    apps: Array<{ appId: string; defaultFeatureFlags: unknown }>;
    meterPolicies: Array<{
      meterKey: string;
      limitType: MeterPolicy["limitType"];
      includedAmount: number | null;
      enforcement: MeterPolicy["enforcement"];
      overageBilling: MeterPolicy["overageBilling"];
    }>;
  };
  overrides: Array<{
    meterKey: string;
    limitType: MeterPolicy["limitType"] | null;
    includedAmount: number | null;
    enforcement: MeterPolicy["enforcement"] | null;
    overageBilling: MeterPolicy["overageBilling"] | null;
    featureFlags: unknown;
  }>;
}

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}
