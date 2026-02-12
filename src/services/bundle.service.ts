import { Prisma } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";
import { EntitlementService } from "./entitlement.service.js";

export interface BundleAppInput {
  appId: string;
  defaultFeatureFlags?: Record<string, boolean> | null;
}

export interface BundleMeterPolicyInput {
  appId: string;
  meterKey: string;
  limitType: "NONE" | "INCLUDED" | "UNLIMITED" | "HARD_CAP";
  includedAmount?: number | null;
  enforcement?: "NONE" | "SOFT" | "HARD";
  overageBilling?: "NONE" | "PER_UNIT" | "TIERED" | "CUSTOM";
  notes?: string | null;
}

export interface CreateBundleInput {
  code: string;
  name: string;
  apps?: BundleAppInput[];
  meterPolicies?: BundleMeterPolicyInput[];
}

export interface UpdateBundleInput {
  name?: string;
  apps?: BundleAppInput[];
  meterPolicies?: BundleMeterPolicyInput[];
}

export class BundleNotFoundError extends Error {
  constructor(id: string) {
    super(`Bundle not found: ${id}`);
    this.name = "BundleNotFoundError";
  }
}

export class BundleCodeConflictError extends Error {
  constructor(code: string) {
    super(`Bundle with code already exists: ${code}`);
    this.name = "BundleCodeConflictError";
  }
}

export class BundleService {
  private entitlementService: EntitlementService;

  constructor(entitlementService?: EntitlementService) {
    this.entitlementService = entitlementService ?? new EntitlementService();
  }

  async createBundle(input: CreateBundleInput) {
    const prisma = getPrismaClient();

    try {
      const bundle = await prisma.$transaction(async (tx) => {
        const created = await tx.bundle.create({
          data: {
            code: input.code,
            name: input.name,
          },
        });

        if (input.apps && input.apps.length > 0) {
          await tx.bundleApp.createMany({
            data: input.apps.map((a) => ({
              bundleId: created.id,
              appId: a.appId,
              defaultFeatureFlags: a.defaultFeatureFlags
                ? (a.defaultFeatureFlags as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            })),
          });
        }

        if (input.meterPolicies && input.meterPolicies.length > 0) {
          await tx.bundleMeterPolicy.createMany({
            data: input.meterPolicies.map((mp) => ({
              bundleId: created.id,
              appId: mp.appId,
              meterKey: mp.meterKey,
              limitType: mp.limitType,
              includedAmount: mp.includedAmount ?? null,
              enforcement: mp.enforcement ?? "NONE",
              overageBilling: mp.overageBilling ?? "NONE",
              notes: mp.notes ?? null,
            })),
          });
        }

        return tx.bundle.findUnique({
          where: { id: created.id },
          include: {
            apps: true,
            meterPolicies: true,
          },
        });
      });

      return bundle;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        throw new BundleCodeConflictError(input.code);
      }
      throw err;
    }
  }

  async updateBundle(id: string, input: UpdateBundleInput) {
    const prisma = getPrismaClient();

    const existing = await prisma.bundle.findUnique({ where: { id } });
    if (!existing) {
      throw new BundleNotFoundError(id);
    }

    const bundle = await prisma.$transaction(async (tx) => {
      if (input.name !== undefined) {
        await tx.bundle.update({
          where: { id },
          data: { name: input.name },
        });
      }

      if (input.apps !== undefined) {
        await tx.bundleApp.deleteMany({ where: { bundleId: id } });
        if (input.apps.length > 0) {
          await tx.bundleApp.createMany({
            data: input.apps.map((a) => ({
              bundleId: id,
              appId: a.appId,
              defaultFeatureFlags: a.defaultFeatureFlags
                ? (a.defaultFeatureFlags as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            })),
          });
        }
      }

      if (input.meterPolicies !== undefined) {
        await tx.bundleMeterPolicy.deleteMany({ where: { bundleId: id } });
        if (input.meterPolicies.length > 0) {
          await tx.bundleMeterPolicy.createMany({
            data: input.meterPolicies.map((mp) => ({
              bundleId: id,
              appId: mp.appId,
              meterKey: mp.meterKey,
              limitType: mp.limitType,
              includedAmount: mp.includedAmount ?? null,
              enforcement: mp.enforcement ?? "NONE",
              overageBilling: mp.overageBilling ?? "NONE",
              notes: mp.notes ?? null,
            })),
          });
        }
      }

      return tx.bundle.findUnique({
        where: { id },
        include: {
          apps: true,
          meterPolicies: true,
        },
      });
    });

    // Trigger entitlement recomputation for affected teams
    await this.refreshAffectedTeams(id);

    return bundle;
  }

  private async refreshAffectedTeams(bundleId: string): Promise<void> {
    const prisma = getPrismaClient();
    const contracts = await prisma.contract.findMany({
      where: { bundleId, status: "ACTIVE" },
      include: { billingEntity: { include: { team: true } } },
    });

    for (const contract of contracts) {
      if (contract.billingEntity?.team) {
        await this.entitlementService.refreshEntitlements(
          contract.billingEntity.team.id,
        );
      }
    }
  }
}
