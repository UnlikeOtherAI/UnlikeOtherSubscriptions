import { Contract } from "@prisma/client";

export interface UsageAggregation {
  appId: string;
  meterKey: string;
  totalAmountMinor: number;
  eventCount: number;
}

export interface ContractWithRelations extends Contract {
  bundle: {
    id: string;
    code: string;
    name: string;
    meterPolicies: Array<{
      appId: string;
      meterKey: string;
      includedAmount: number | null;
    }>;
  };
  overrides: Array<{
    appId: string;
    meterKey: string;
    includedAmount: number | null;
  }>;
}

export interface InvoiceLineItemInput {
  appId: string | null;
  type: "BASE_FEE" | "USAGE_TRUEUP" | "ADDON" | "CREDIT" | "ADJUSTMENT";
  description: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
  usageSummary: Record<string, unknown> | null;
}

/**
 * Build invoice line items for a contract based on its pricing mode.
 */
export function buildLineItems(
  contract: ContractWithRelations,
  usage: UsageAggregation[],
): InvoiceLineItemInput[] {
  switch (contract.pricingMode) {
    case "FIXED":
      return buildFixedLineItems(contract);
    case "FIXED_PLUS_TRUEUP":
      return buildFixedPlusTrueupLineItems(contract, usage);
    case "MIN_COMMIT_TRUEUP":
      return buildMinCommitTrueupLineItems(contract, usage);
    case "CUSTOM_INVOICE_ONLY":
      return buildCustomInvoiceLineItems(contract, usage);
  }
}

function buildFixedLineItems(
  contract: ContractWithRelations,
): InvoiceLineItemInput[] {
  return [
    {
      appId: null,
      type: "BASE_FEE",
      description: `Fixed fee — ${contract.bundle.name}`,
      quantity: 1,
      unitPriceMinor: 0,
      amountMinor: 0,
      usageSummary: null,
    },
  ];
}

function buildFixedPlusTrueupLineItems(
  contract: ContractWithRelations,
  usage: UsageAggregation[],
): InvoiceLineItemInput[] {
  const lines: InvoiceLineItemInput[] = [
    {
      appId: null,
      type: "BASE_FEE",
      description: `Fixed fee — ${contract.bundle.name}`,
      quantity: 1,
      unitPriceMinor: 0,
      amountMinor: 0,
      usageSummary: null,
    },
  ];

  for (const u of usage) {
    const included = getIncludedAmount(contract, u.appId, u.meterKey);
    if (u.totalAmountMinor > included) {
      const overage = u.totalAmountMinor - included;
      lines.push({
        appId: u.appId,
        type: "USAGE_TRUEUP",
        description: `Usage true-up: ${u.meterKey}`,
        quantity: u.eventCount,
        unitPriceMinor:
          u.eventCount > 0 ? Math.round(overage / u.eventCount) : 0,
        amountMinor: overage,
        usageSummary: {
          meterKey: u.meterKey,
          totalUsageMinor: u.totalAmountMinor,
          includedMinor: included,
          overageMinor: overage,
          eventCount: u.eventCount,
        },
      });
    }
  }

  return lines;
}

/**
 * MIN_COMMIT_TRUEUP: charges the greater of total usage vs minimum commit.
 *
 * The BASE_FEE line carries the entire charge amount (max of usage, minCommit).
 * USAGE_TRUEUP lines are informational detail only (amountMinor: 0) to avoid
 * double-charging — the usage is already included in the BASE_FEE.
 */
function buildMinCommitTrueupLineItems(
  contract: ContractWithRelations,
  usage: UsageAggregation[],
): InvoiceLineItemInput[] {
  const totalUsage = usage.reduce(
    (sum, u) => sum + u.totalAmountMinor,
    0,
  );

  const minCommit = 0; // From contract terms (not modeled yet)
  const chargeAmount = Math.max(totalUsage, minCommit);

  const lines: InvoiceLineItemInput[] = [
    {
      appId: null,
      type: "BASE_FEE",
      description: `Minimum commit / usage charge — ${contract.bundle.name}`,
      quantity: 1,
      unitPriceMinor: chargeAmount,
      amountMinor: chargeAmount,
      usageSummary: {
        totalUsageMinor: totalUsage,
        minimumCommitMinor: minCommit,
        chargedMinor: chargeAmount,
      },
    },
  ];

  // Per-meter detail lines are informational only (amountMinor: 0)
  // to avoid double-charging — the full amount is in the BASE_FEE
  for (const u of usage) {
    lines.push({
      appId: u.appId,
      type: "USAGE_TRUEUP",
      description: `Usage detail: ${u.meterKey}`,
      quantity: u.eventCount,
      unitPriceMinor:
        u.eventCount > 0
          ? Math.round(u.totalAmountMinor / u.eventCount)
          : 0,
      amountMinor: 0,
      usageSummary: {
        meterKey: u.meterKey,
        totalAmountMinor: u.totalAmountMinor,
        eventCount: u.eventCount,
      },
    });
  }

  return lines;
}

function buildCustomInvoiceLineItems(
  contract: ContractWithRelations,
  usage: UsageAggregation[],
): InvoiceLineItemInput[] {
  const lines: InvoiceLineItemInput[] = [
    {
      appId: null,
      type: "BASE_FEE",
      description: `Draft invoice — ${contract.bundle.name} (manual review)`,
      quantity: 1,
      unitPriceMinor: 0,
      amountMinor: 0,
      usageSummary: null,
    },
  ];

  for (const u of usage) {
    lines.push({
      appId: u.appId,
      type: "USAGE_TRUEUP",
      description: `Usage: ${u.meterKey}`,
      quantity: u.eventCount,
      unitPriceMinor:
        u.eventCount > 0
          ? Math.round(u.totalAmountMinor / u.eventCount)
          : 0,
      amountMinor: u.totalAmountMinor,
      usageSummary: {
        meterKey: u.meterKey,
        totalAmountMinor: u.totalAmountMinor,
        eventCount: u.eventCount,
      },
    });
  }

  return lines;
}

/**
 * Resolve the included amount for a meter, checking contract overrides first,
 * then falling back to bundle meter policies.
 */
export function getIncludedAmount(
  contract: ContractWithRelations,
  appId: string,
  meterKey: string,
): number {
  const override = contract.overrides.find(
    (o) => o.appId === appId && o.meterKey === meterKey,
  );
  if (override?.includedAmount != null) {
    return override.includedAmount;
  }

  const policy = contract.bundle.meterPolicies.find(
    (p) => p.appId === appId && p.meterKey === meterKey,
  );
  if (policy?.includedAmount != null) {
    return policy.includedAmount;
  }

  return 0;
}
