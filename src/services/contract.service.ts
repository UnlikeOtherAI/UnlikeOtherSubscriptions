import { Prisma } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";
import { EntitlementService } from "./entitlement.service.js";

export interface CreateContractInput {
  billToId: string;
  bundleId: string;
  currency: string;
  billingPeriod: "MONTHLY" | "QUARTERLY";
  termsDays: number;
  pricingMode:
    | "FIXED"
    | "FIXED_PLUS_TRUEUP"
    | "MIN_COMMIT_TRUEUP"
    | "CUSTOM_INVOICE_ONLY";
  startsAt: string;
  endsAt?: string | null;
}

export interface UpdateContractInput {
  status?: "DRAFT" | "ACTIVE" | "PAUSED" | "ENDED";
  termsDays?: number;
  pricingMode?:
    | "FIXED"
    | "FIXED_PLUS_TRUEUP"
    | "MIN_COMMIT_TRUEUP"
    | "CUSTOM_INVOICE_ONLY";
}

export interface ContractOverrideInput {
  appId: string;
  meterKey: string;
  limitType?: "NONE" | "INCLUDED" | "UNLIMITED" | "HARD_CAP";
  includedAmount?: number | null;
  overageBilling?: "NONE" | "PER_UNIT" | "TIERED" | "CUSTOM";
  enforcement?: "NONE" | "SOFT" | "HARD";
  featureFlags?: Record<string, boolean> | null;
}

export class ContractNotFoundError extends Error {
  constructor(id: string) {
    super(`Contract not found: ${id}`);
    this.name = "ContractNotFoundError";
  }
}

export class BundleNotFoundError extends Error {
  constructor(id: string) {
    super(`Bundle not found: ${id}`);
    this.name = "BundleNotFoundError";
  }
}

export class BillingEntityNotFoundError extends Error {
  constructor(id: string) {
    super(`BillingEntity not found: ${id}`);
    this.name = "BillingEntityNotFoundError";
  }
}

export class ActiveContractExistsError extends Error {
  constructor(billToId: string) {
    super(
      `An active contract already exists for billing entity: ${billToId}`,
    );
    this.name = "ActiveContractExistsError";
  }
}

export class ContractService {
  private entitlementService: EntitlementService;

  constructor(entitlementService?: EntitlementService) {
    this.entitlementService = entitlementService ?? new EntitlementService();
  }

  async createContract(input: CreateContractInput) {
    const prisma = getPrismaClient();

    const billingEntity = await prisma.billingEntity.findUnique({
      where: { id: input.billToId },
    });
    if (!billingEntity) {
      throw new BillingEntityNotFoundError(input.billToId);
    }

    const bundle = await prisma.bundle.findUnique({
      where: { id: input.bundleId },
    });
    if (!bundle) {
      throw new BundleNotFoundError(input.bundleId);
    }

    const contract = await prisma.contract.create({
      data: {
        billToId: input.billToId,
        bundleId: input.bundleId,
        currency: input.currency,
        billingPeriod: input.billingPeriod,
        termsDays: input.termsDays,
        pricingMode: input.pricingMode,
        startsAt: new Date(input.startsAt),
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        status: "DRAFT",
      },
      include: {
        bundle: true,
        overrides: true,
      },
    });

    return contract;
  }

  async updateContract(id: string, input: UpdateContractInput) {
    const prisma = getPrismaClient();

    const existing = await prisma.contract.findUnique({
      where: { id },
      include: { billingEntity: { include: { team: true } } },
    });
    if (!existing) {
      throw new ContractNotFoundError(id);
    }

    // If transitioning to ACTIVE, check unique partial index constraint
    if (input.status === "ACTIVE" && existing.status !== "ACTIVE") {
      const existingActive = await prisma.contract.findFirst({
        where: {
          billToId: existing.billToId,
          status: "ACTIVE",
          id: { not: id },
        },
      });
      if (existingActive) {
        throw new ActiveContractExistsError(existing.billToId);
      }
    }

    const contract = await prisma.contract.update({
      where: { id },
      data: {
        ...(input.status !== undefined && { status: input.status }),
        ...(input.termsDays !== undefined && { termsDays: input.termsDays }),
        ...(input.pricingMode !== undefined && {
          pricingMode: input.pricingMode,
        }),
      },
      include: {
        bundle: true,
        overrides: true,
      },
    });

    // Trigger entitlement recomputation for affected teams
    if (existing.billingEntity?.team) {
      await this.entitlementService.refreshEntitlements(
        existing.billingEntity.team.id,
      );
    }

    return contract;
  }

  async replaceOverrides(
    contractId: string,
    overrides: ContractOverrideInput[],
  ) {
    const prisma = getPrismaClient();

    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
      include: { billingEntity: { include: { team: true } } },
    });
    if (!contract) {
      throw new ContractNotFoundError(contractId);
    }

    // Replace all overrides in a transaction
    const result = await prisma.$transaction(async (tx) => {
      await tx.contractOverride.deleteMany({
        where: { contractId },
      });

      if (overrides.length > 0) {
        await tx.contractOverride.createMany({
          data: overrides.map((o) => ({
            contractId,
            appId: o.appId,
            meterKey: o.meterKey,
            limitType: o.limitType ?? null,
            includedAmount: o.includedAmount ?? null,
            overageBilling: o.overageBilling ?? null,
            enforcement: o.enforcement ?? null,
            featureFlags: o.featureFlags
              ? (o.featureFlags as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          })),
        });
      }

      return tx.contractOverride.findMany({
        where: { contractId },
      });
    });

    // Trigger entitlement recomputation for affected teams
    if (contract.billingEntity?.team) {
      await this.entitlementService.refreshEntitlements(
        contract.billingEntity.team.id,
      );
    }

    return result;
  }
}
