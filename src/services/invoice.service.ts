import { PrismaClient, Prisma } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";
import {
  LedgerService,
  DuplicateLedgerEntryError,
} from "./ledger.service.js";
import {
  buildLineItems,
  ContractWithRelations,
  UsageAggregation,
} from "./invoice-line-items.js";

export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice not found: ${invoiceId}`);
    this.name = "InvoiceNotFoundError";
  }
}

export class InvalidInvoiceStatusError extends Error {
  constructor(invoiceId: string, currentStatus: string) {
    super(
      `Invoice ${invoiceId} has status ${currentStatus}, expected ISSUED`,
    );
    this.name = "InvalidInvoiceStatusError";
  }
}

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}

export class BillingEntityNotFoundError extends Error {
  constructor(teamId: string) {
    super(`No billing entity found for team: ${teamId}`);
    this.name = "BillingEntityNotFoundError";
  }
}

export interface GenerateInvoiceInput {
  teamId: string;
  periodStart: string;
  periodEnd: string;
}

export interface GenerateInvoiceResult {
  id: string;
  billToId: string;
  contractId: string | null;
  periodStart: Date;
  periodEnd: Date;
  status: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  lineItemCount: number;
}

export interface InvoiceExport {
  invoice: {
    id: string;
    billToId: string;
    contractId: string | null;
    periodStart: string;
    periodEnd: string;
    status: string;
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    externalRef: string | null;
    issuedAt: string | null;
    dueAt: string | null;
    createdAt: string;
  };
  lineItems: Array<{
    id: string;
    appId: string | null;
    type: string;
    description: string;
    quantity: number;
    unitPriceMinor: number;
    amountMinor: number;
    usageSummary: unknown;
  }>;
}

export class InvoiceService {
  private prisma: PrismaClient;
  private ledgerService: LedgerService;

  constructor(prisma?: PrismaClient, ledgerService?: LedgerService) {
    this.prisma = prisma ?? getPrismaClient();
    this.ledgerService = ledgerService ?? new LedgerService();
  }

  async generate(input: GenerateInvoiceInput): Promise<GenerateInvoiceResult> {
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);

    const team = await this.prisma.team.findUnique({
      where: { id: input.teamId },
      include: { billingEntity: true },
    });

    if (!team) {
      throw new TeamNotFoundError(input.teamId);
    }

    if (!team.billingEntity) {
      throw new BillingEntityNotFoundError(input.teamId);
    }

    const billToId = team.billingEntity.id;

    // Check for existing invoice for this team+period (idempotent)
    const existing = await this.prisma.invoice.findFirst({
      where: { billToId, periodStart, periodEnd },
      include: { lineItems: true },
    });

    if (existing) {
      return {
        id: existing.id,
        billToId: existing.billToId,
        contractId: existing.contractId,
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        status: existing.status,
        subtotalMinor: existing.subtotalMinor,
        taxMinor: existing.taxMinor,
        totalMinor: existing.totalMinor,
        lineItemCount: existing.lineItems.length,
      };
    }

    // Aggregate usage for the period
    const usage = await this.aggregateUsage(billToId, periodStart, periodEnd);

    const subtotalMinor = usage.reduce(
      (sum, u) => sum + u.totalAmountMinor,
      0,
    );
    const taxMinor = 0;
    const totalMinor = subtotalMinor + taxMinor;

    const invoice = await this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          billToId,
          contractId: null,
          periodStart,
          periodEnd,
          status: "ISSUED",
          subtotalMinor,
          taxMinor,
          totalMinor,
          issuedAt: new Date(),
        },
      });

      for (const u of usage) {
        await tx.invoiceLineItem.create({
          data: {
            invoiceId: inv.id,
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
            } as Prisma.InputJsonValue,
          },
        });
      }

      // If no usage, create a zero-amount line
      if (usage.length === 0) {
        await tx.invoiceLineItem.create({
          data: {
            invoiceId: inv.id,
            appId: null,
            type: "BASE_FEE",
            description: "No usage in period",
            quantity: 1,
            unitPriceMinor: 0,
            amountMinor: 0,
            usageSummary: Prisma.JsonNull,
          },
        });
      }

      return inv;
    });

    const lineItemCount =
      usage.length > 0 ? usage.length : 1;

    return {
      id: invoice.id,
      billToId: invoice.billToId,
      contractId: invoice.contractId,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      status: invoice.status,
      subtotalMinor: invoice.subtotalMinor,
      taxMinor: invoice.taxMinor,
      totalMinor: invoice.totalMinor,
      lineItemCount,
    };
  }

  async getById(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { lineItems: true },
    });

    if (!invoice) {
      throw new InvoiceNotFoundError(invoiceId);
    }

    return invoice;
  }

  async export(invoiceId: string): Promise<InvoiceExport> {
    const invoice = await this.getById(invoiceId);

    return {
      invoice: {
        id: invoice.id,
        billToId: invoice.billToId,
        contractId: invoice.contractId,
        periodStart: invoice.periodStart.toISOString(),
        periodEnd: invoice.periodEnd.toISOString(),
        status: invoice.status,
        subtotalMinor: invoice.subtotalMinor,
        taxMinor: invoice.taxMinor,
        totalMinor: invoice.totalMinor,
        externalRef: invoice.externalRef,
        issuedAt: invoice.issuedAt?.toISOString() ?? null,
        dueAt: invoice.dueAt?.toISOString() ?? null,
        createdAt: invoice.createdAt.toISOString(),
      },
      lineItems: invoice.lineItems.map((li) => ({
        id: li.id,
        appId: li.appId,
        type: li.type,
        description: li.description,
        quantity: li.quantity,
        unitPriceMinor: li.unitPriceMinor,
        amountMinor: li.amountMinor,
        usageSummary: li.usageSummary,
      })),
    };
  }

  async markPaid(invoiceId: string): Promise<{ id: string; status: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });

    if (!invoice) {
      throw new InvoiceNotFoundError(invoiceId);
    }

    if (invoice.status !== "ISSUED") {
      // Idempotent: already paid
      if (invoice.status === "PAID") {
        return { id: invoice.id, status: invoice.status };
      }
      throw new InvalidInvoiceStatusError(invoiceId, invoice.status);
    }

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: "PAID" },
    });

    // Create INVOICE_PAYMENT ledger entry
    const idempotencyKey = `invoice-payment:${invoiceId}`;

    // Determine appId: use first line item's appId, or fallback to "system"
    const firstLineItem = await this.prisma.invoiceLineItem.findFirst({
      where: { invoiceId },
    });
    const appId = firstLineItem?.appId ?? "system";

    try {
      await this.ledgerService.createEntry({
        appId,
        billToId: invoice.billToId,
        accountType: "ACCOUNTS_RECEIVABLE",
        type: "INVOICE_PAYMENT",
        amountMinor: -invoice.totalMinor,
        currency: "USD",
        referenceType: "MANUAL",
        referenceId: invoiceId,
        idempotencyKey,
        metadata: {
          invoiceId,
          action: "mark-paid",
          totalMinor: invoice.totalMinor,
        },
      });
    } catch (err) {
      if (err instanceof DuplicateLedgerEntryError) {
        // Already recorded - idempotent
      } else {
        throw err;
      }
    }

    return { id: updated.id, status: updated.status };
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
}
