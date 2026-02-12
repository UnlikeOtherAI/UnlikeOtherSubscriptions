import { PrismaClient, Prisma, Contract } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";
import { LedgerService } from "./ledger.service.js";
import {
  buildLineItems,
  ContractWithRelations,
  InvoiceLineItemInput,
  UsageAggregation,
} from "./invoice-line-items.js";

export type { ContractWithRelations } from "./invoice-line-items.js";

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
        const invoiceResult = await this.processContract(contract, now);
        if (invoiceResult) {
          result.invoices.push(invoiceResult);
          result.processed++;
        } else {
          result.skipped++;
        }
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

  /**
   * Process a single contract: create invoice if needed, then ensure all
   * ledger entries exist. Returns null if already fully processed.
   */
  private async processContract(
    contract: ContractWithRelations,
    asOf: Date,
  ): Promise<PeriodCloseResult | null> {
    const { periodStart, periodEnd } = this.getCurrentPeriodBounds(
      contract,
      asOf,
    );

    const existing = await this.prisma.invoice.findFirst({
      where: { contractId: contract.id, periodStart, periodEnd },
      include: { lineItems: true },
    });

    if (existing) {
      // Invoice exists — repair any missing ledger entries from a partial run
      const lineItemInputs = this.rebuildLineItemInputs(existing.lineItems);
      await this.writeLedgerEntries(contract, existing.id, lineItemInputs);
      return null;
    }

    return this.closeContractPeriod(contract, asOf);
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
              select: { appId: true, meterKey: true, includedAmount: true },
            },
          },
        },
        overrides: {
          select: { appId: true, meterKey: true, includedAmount: true },
        },
      },
    });

    return contracts.filter((c) => {
      const periodEnd = this.getCurrentPeriodEnd(c, asOf);
      return periodEnd <= asOf;
    });
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

    const lineItems = buildLineItems(contract, usage);

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
          issuedAt: invoiceStatus === "ISSUED" ? new Date() : null,
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

    // Write ledger entries outside the invoice transaction to keep txns short.
    // Each entry is individually idempotent via its idempotencyKey.
    await this.writeLedgerEntries(contract, invoice.id, lineItems);

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
      include: { priceBook: { select: { kind: true } } },
    });

    const grouped = new Map<string, UsageAggregation>();

    for (const item of items) {
      const snapshot = item.inputsSnapshot as Record<string, unknown>;
      const eventType = (snapshot?.eventType as string) ?? "unknown";
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

  /**
   * Rebuild InvoiceLineItemInput[] from persisted InvoiceLineItem records.
   * Used during rerun recovery to write missing ledger entries.
   */
  private rebuildLineItemInputs(
    persisted: Array<{
      appId: string | null;
      type: string;
      description: string;
      quantity: number;
      unitPriceMinor: number;
      amountMinor: number;
      usageSummary: unknown;
    }>,
  ): InvoiceLineItemInput[] {
    return persisted.map((li) => ({
      appId: li.appId,
      type: li.type as InvoiceLineItemInput["type"],
      description: li.description,
      quantity: li.quantity,
      unitPriceMinor: li.unitPriceMinor,
      amountMinor: li.amountMinor,
      usageSummary: li.usageSummary as Record<string, unknown> | null,
    }));
  }

  private async writeLedgerEntries(
    contract: ContractWithRelations,
    invoiceId: string,
    lineItems: InvoiceLineItemInput[],
  ): Promise<void> {
    const bundleApps = contract.bundle.meterPolicies;
    const fallbackAppId =
      bundleApps.length > 0 ? bundleApps[0].appId : "system";

    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      const idempotencyKey = `period-close:${contract.id}:${invoiceId}:${i}`;

      try {
        await this.ledgerService.createEntry({
          appId: li.appId ?? fallbackAppId,
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
