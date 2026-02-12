import { PrismaClient, Prisma, Contract, PricingMode } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";
import { LedgerService } from "./ledger.service.js";

export interface PeriodCloseResult {
  contractId: string;
  invoiceId: string;
  status: "ISSUED" | "DRAFT";
  lineItemCount: number;
  totalMinor: number;
}

export interface PeriodCloseRunResult {
  processed: number;
  skipped: number;
  failed: number;
  invoices: PeriodCloseResult[];
  errors: Array<{ contractId: string; error: string }>;
}

interface UsageAggregation {
  appId: string;
  meterKey: string;
  totalAmountMinor: number;
  eventCount: number;
}

interface ContractWithRelations extends Contract {
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

export class PeriodCloseService {
  private prisma: PrismaClient;
  private ledgerService: LedgerService;

  constructor(prisma?: PrismaClient, ledgerService?: LedgerService) {
    this.prisma = prisma ?? getPrismaClient();
    this.ledgerService = ledgerService ?? new LedgerService();
  }

  async runPeriodClose(asOf?: Date): Promise<PeriodCloseRunResult> {
    const now = asOf ?? new Date();
    const result: PeriodCloseRunResult = {
      processed: 0,
      skipped: 0,
      failed: 0,
      invoices: [],
      errors: [],
    };

    const contracts = await this.findContractsDueForClose(now);

    for (const contract of contracts) {
      try {
        const existing = await this.findExistingInvoice(contract, now);
        if (existing) {
          result.skipped++;
          continue;
        }

        const invoiceResult = await this.closeContractPeriod(contract, now);
        result.invoices.push(invoiceResult);
        result.processed++;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        console.error(
          `[period-close] Failed to close period for contract ${contract.id}: ${message}`,
        );
        result.errors.push({ contractId: contract.id, error: message });
        result.failed++;
      }
    }

    return result;
  }

  async findContractsDueForClose(
    asOf: Date,
  ): Promise<ContractWithRelations[]> {
    const contracts = await this.prisma.contract.findMany({
      where: { status: "ACTIVE" },
      include: {
        bundle: {
          include: {
            meterPolicies: {
              select: {
                appId: true,
                meterKey: true,
                includedAmount: true,
              },
            },
          },
        },
        overrides: {
          select: {
            appId: true,
            meterKey: true,
            includedAmount: true,
          },
        },
      },
    });

    return contracts.filter((c) => {
      const periodEnd = this.getCurrentPeriodEnd(c, asOf);
      return periodEnd <= asOf;
    });
  }

  private async findExistingInvoice(
    contract: ContractWithRelations,
    asOf: Date,
  ): Promise<boolean> {
    const { periodStart, periodEnd } = this.getCurrentPeriodBounds(
      contract,
      asOf,
    );

    const existing = await this.prisma.invoice.findFirst({
      where: {
        contractId: contract.id,
        periodStart,
        periodEnd,
      },
    });

    return !!existing;
  }

  async closeContractPeriod(
    contract: ContractWithRelations,
    asOf: Date,
  ): Promise<PeriodCloseResult> {
    const { periodStart, periodEnd } = this.getCurrentPeriodBounds(
      contract,
      asOf,
    );

    const usage = await this.aggregateUsage(
      contract.billToId,
      periodStart,
      periodEnd,
    );

    const lineItems = this.buildLineItems(contract, usage);

    const subtotalMinor = lineItems.reduce(
      (sum, li) => sum + li.amountMinor,
      0,
    );
    const taxMinor = 0;
    const totalMinor = subtotalMinor + taxMinor;

    const invoiceStatus =
      contract.pricingMode === "CUSTOM_INVOICE_ONLY" ? "DRAFT" : "ISSUED";

    const invoice = await this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          billToId: contract.billToId,
          contractId: contract.id,
          periodStart,
          periodEnd,
          status: invoiceStatus,
          subtotalMinor,
          taxMinor,
          totalMinor,
          issuedAt:
            invoiceStatus === "ISSUED" ? new Date() : null,
          dueAt: this.computeDueDate(contract),
        },
      });

      for (const li of lineItems) {
        await tx.invoiceLineItem.create({
          data: {
            invoiceId: inv.id,
            appId: li.appId,
            type: li.type,
            description: li.description,
            quantity: li.quantity,
            unitPriceMinor: li.unitPriceMinor,
            amountMinor: li.amountMinor,
            usageSummary: li.usageSummary
              ? (li.usageSummary as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          },
        });
      }

      return inv;
    });

    // Write ledger entries outside the invoice transaction
    // to keep transactions short. Each ledger entry is individually idempotent.
    await this.writeLedgerEntries(
      contract,
      invoice.id,
      lineItems,
    );

    return {
      contractId: contract.id,
      invoiceId: invoice.id,
      status: invoiceStatus,
      lineItemCount: lineItems.length,
      totalMinor,
    };
  }

  private async aggregateUsage(
    billToId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<UsageAggregation[]> {
    const items = await this.prisma.billableLineItem.findMany({
      where: {
        billToId,
        timestamp: { gte: periodStart, lt: periodEnd },
        priceBook: { kind: "CUSTOMER" },
      },
      include: {
        priceBook: { select: { kind: true } },
      },
    });

    const grouped = new Map<string, UsageAggregation>();

    for (const item of items) {
      const snapshot = item.inputsSnapshot as Record<string, unknown>;
      const eventType =
        (snapshot?.eventType as string) ?? "unknown";
      const key = `${item.appId}::${eventType}`;

      const existing = grouped.get(key);
      if (existing) {
        existing.totalAmountMinor += item.amountMinor;
        existing.eventCount++;
      } else {
        grouped.set(key, {
          appId: item.appId,
          meterKey: eventType,
          totalAmountMinor: item.amountMinor,
          eventCount: 1,
        });
      }
    }

    return Array.from(grouped.values());
  }

  private buildLineItems(
    contract: ContractWithRelations,
    usage: UsageAggregation[],
  ): InvoiceLineItemInput[] {
    switch (contract.pricingMode) {
      case "FIXED":
        return this.buildFixedLineItems(contract, usage);
      case "FIXED_PLUS_TRUEUP":
        return this.buildFixedPlusTrueupLineItems(contract, usage);
      case "MIN_COMMIT_TRUEUP":
        return this.buildMinCommitTrueupLineItems(contract, usage);
      case "CUSTOM_INVOICE_ONLY":
        return this.buildCustomInvoiceLineItems(contract, usage);
    }
  }

  private buildFixedLineItems(
    contract: ContractWithRelations,
    _usage: UsageAggregation[],
  ): InvoiceLineItemInput[] {
    // FIXED: single BASE_FEE line, no usage charges
    return [
      {
        appId: null,
        type: "BASE_FEE" as const,
        description: `Fixed fee — ${contract.bundle.name}`,
        quantity: 1,
        unitPriceMinor: 0, // Fixed fee amount comes from contract terms
        amountMinor: 0,
        usageSummary: null,
      },
    ];
  }

  private buildFixedPlusTrueupLineItems(
    contract: ContractWithRelations,
    usage: UsageAggregation[],
  ): InvoiceLineItemInput[] {
    const lines: InvoiceLineItemInput[] = [
      {
        appId: null,
        type: "BASE_FEE" as const,
        description: `Fixed fee — ${contract.bundle.name}`,
        quantity: 1,
        unitPriceMinor: 0,
        amountMinor: 0,
        usageSummary: null,
      },
    ];

    // Add USAGE_TRUEUP lines for meters exceeding included amounts
    for (const u of usage) {
      const included = this.getIncludedAmount(
        contract,
        u.appId,
        u.meterKey,
      );
      if (u.totalAmountMinor > included) {
        const overage = u.totalAmountMinor - included;
        lines.push({
          appId: u.appId,
          type: "USAGE_TRUEUP" as const,
          description: `Usage true-up: ${u.meterKey}`,
          quantity: u.eventCount,
          unitPriceMinor:
            u.eventCount > 0
              ? Math.round(overage / u.eventCount)
              : 0,
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

  private buildMinCommitTrueupLineItems(
    contract: ContractWithRelations,
    usage: UsageAggregation[],
  ): InvoiceLineItemInput[] {
    const totalUsage = usage.reduce(
      (sum, u) => sum + u.totalAmountMinor,
      0,
    );

    // MIN_COMMIT_TRUEUP: charges the greater of usage total vs minimum commit
    // The BASE_FEE amount here represents the minimum commit
    const minCommit = 0; // From contract terms (not modeled yet)
    const chargeAmount = Math.max(totalUsage, minCommit);

    const lines: InvoiceLineItemInput[] = [
      {
        appId: null,
        type: "BASE_FEE" as const,
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

    // Add per-meter detail lines
    for (const u of usage) {
      lines.push({
        appId: u.appId,
        type: "USAGE_TRUEUP" as const,
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

  private buildCustomInvoiceLineItems(
    contract: ContractWithRelations,
    usage: UsageAggregation[],
  ): InvoiceLineItemInput[] {
    // CUSTOM_INVOICE_ONLY: draft invoice for manual review
    const lines: InvoiceLineItemInput[] = [
      {
        appId: null,
        type: "BASE_FEE" as const,
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
        type: "USAGE_TRUEUP" as const,
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

  private getIncludedAmount(
    contract: ContractWithRelations,
    appId: string,
    meterKey: string,
  ): number {
    // ContractOverride takes priority
    const override = contract.overrides.find(
      (o) => o.appId === appId && o.meterKey === meterKey,
    );
    if (override?.includedAmount != null) {
      return override.includedAmount;
    }

    // Fall back to BundleMeterPolicy
    const policy = contract.bundle.meterPolicies.find(
      (p) => p.appId === appId && p.meterKey === meterKey,
    );
    if (policy?.includedAmount != null) {
      return policy.includedAmount;
    }

    return 0;
  }

  private async writeLedgerEntries(
    contract: ContractWithRelations,
    invoiceId: string,
    lineItems: InvoiceLineItemInput[],
  ): Promise<void> {
    // Determine appId for ledger — use first app from bundle, or contract's own context
    const bundleApps = contract.bundle.meterPolicies;
    const appId =
      bundleApps.length > 0 ? bundleApps[0].appId : "system";

    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      const idempotencyKey = `period-close:${contract.id}:${invoiceId}:${i}`;

      try {
        await this.ledgerService.createEntry({
          appId: li.appId ?? appId,
          billToId: contract.billToId,
          accountType: "ACCOUNTS_RECEIVABLE",
          type:
            li.type === "BASE_FEE"
              ? "SUBSCRIPTION_CHARGE"
              : "USAGE_CHARGE",
          amountMinor: li.amountMinor,
          currency: contract.currency,
          referenceType: "MANUAL",
          referenceId: invoiceId,
          idempotencyKey,
          metadata: {
            invoiceId,
            contractId: contract.id,
            lineItemType: li.type,
            description: li.description,
          },
        });
      } catch (err) {
        // DuplicateLedgerEntryError means idempotent re-run — safe to ignore
        if (
          err instanceof Error &&
          err.name === "DuplicateLedgerEntryError"
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  getCurrentPeriodEnd(contract: Contract, asOf: Date): Date {
    const { periodEnd } = this.getCurrentPeriodBounds(contract, asOf);
    return periodEnd;
  }

  getCurrentPeriodBounds(
    contract: Contract,
    asOf: Date,
  ): { periodStart: Date; periodEnd: Date } {
    const start = new Date(contract.startsAt);
    const monthsPerPeriod =
      contract.billingPeriod === "QUARTERLY" ? 3 : 1;

    let periodStart = new Date(start);
    let periodEnd = this.addMonths(periodStart, monthsPerPeriod);

    while (periodEnd <= asOf) {
      periodStart = new Date(periodEnd);
      periodEnd = this.addMonths(periodStart, monthsPerPeriod);
    }

    // Return the most recent completed period (the one before the current open period)
    // If we walked past asOf, the previous period is complete
    const prevPeriodStart = this.subtractMonths(
      periodStart,
      monthsPerPeriod,
    );
    if (prevPeriodStart >= start) {
      return {
        periodStart: prevPeriodStart,
        periodEnd: periodStart,
      };
    }

    return { periodStart, periodEnd };
  }

  private addMonths(date: Date, months: number): Date {
    const result = new Date(date);
    result.setUTCMonth(result.getUTCMonth() + months);
    return result;
  }

  private subtractMonths(date: Date, months: number): Date {
    return this.addMonths(date, -months);
  }

  private computeDueDate(contract: Contract): Date {
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + contract.termsDays);
    return due;
  }
}

interface InvoiceLineItemInput {
  appId: string | null;
  type: "BASE_FEE" | "USAGE_TRUEUP" | "ADDON" | "CREDIT" | "ADJUSTMENT";
  description: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
  usageSummary: Record<string, unknown> | null;
}
