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
   * Algorithm (V1, no enterprise contracts):
   * 1. Look up the team's BillingEntity
   * 2. Check for an ACTIVE contract on that billing entity
   * 3. If active contract exists: return enterprise mode (implemented in future task)
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

    const billingMode = team.billingMode;

    // Look up the team's active subscription for this app
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

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}
