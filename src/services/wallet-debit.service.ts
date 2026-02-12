import { PrismaClient, BillableLineItem } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";
import { LedgerService, DuplicateLedgerEntryError } from "./ledger.service.js";
import { TopupService } from "./topup.service.js";

export class WalletDebitService {
  private prisma: PrismaClient;
  private ledgerService: LedgerService;
  private topupService: TopupService;

  constructor(
    prisma?: PrismaClient,
    ledgerService?: LedgerService,
    topupService?: TopupService,
  ) {
    this.prisma = prisma ?? getPrismaClient();
    this.ledgerService = ledgerService ?? new LedgerService();
    this.topupService = topupService ?? new TopupService();
  }

  /**
   * Immediate debit: create a USAGE_CHARGE ledger entry for a single
   * BillableLineItem on a WALLET-mode team. Called when a BillableLineItem
   * is created and the team's billingMode is WALLET.
   */
  async debitImmediate(lineItemId: string): Promise<string | null> {
    const lineItem = await this.prisma.billableLineItem.findUnique({
      where: { id: lineItemId },
    });

    if (!lineItem) {
      return null;
    }

    if (lineItem.walletDebitedAt) {
      return null; // Already debited
    }

    const team = await this.prisma.team.findUnique({
      where: { id: lineItem.teamId },
    });

    if (!team || team.billingMode !== "WALLET") {
      return null;
    }

    // Only debit CUSTOMER line items, not COGS
    const priceBook = await this.prisma.priceBook.findUnique({
      where: { id: lineItem.priceBookId },
    });

    if (!priceBook || priceBook.kind !== "CUSTOMER") {
      return null;
    }

    const entryId = await this.createDebitEntry(lineItem);

    await this.prisma.billableLineItem.update({
      where: { id: lineItem.id },
      data: { walletDebitedAt: new Date() },
    });

    await this.topupService.checkAndTriggerAutoTopUp(
      lineItem.appId,
      lineItem.teamId,
    );

    return entryId;
  }

  /**
   * Daily batch debit: aggregate all undebited CUSTOMER BillableLineItems
   * for WALLET-mode teams and create a single debit entry per team+app.
   */
  async debitBatch(): Promise<{
    teamsProcessed: number;
    entriesCreated: number;
    itemsDebited: number;
  }> {
    const undebited = await this.prisma.billableLineItem.findMany({
      where: {
        walletDebitedAt: null,
      },
      include: {
        priceBook: { select: { kind: true } },
      },
      orderBy: { timestamp: "asc" },
    });

    // Filter to CUSTOMER-kind only
    const customerItems = undebited.filter(
      (item) => item.priceBook.kind === "CUSTOMER",
    );

    if (customerItems.length === 0) {
      return { teamsProcessed: 0, entriesCreated: 0, itemsDebited: 0 };
    }

    // Group by teamId + appId
    const groups = new Map<string, typeof customerItems>();
    for (const item of customerItems) {
      const key = `${item.teamId}:${item.appId}`;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }

    let teamsProcessed = 0;
    let entriesCreated = 0;
    let itemsDebited = 0;

    for (const [, items] of groups) {
      const firstItem = items[0];

      // Check if the team is in WALLET mode
      const team = await this.prisma.team.findUnique({
        where: { id: firstItem.teamId },
      });

      if (!team || team.billingMode !== "WALLET") {
        continue;
      }

      const totalAmount = items.reduce(
        (sum, item) => sum + item.amountMinor,
        0,
      );

      if (totalAmount === 0) {
        // Mark all as debited even if zero
        const itemIds = items.map((i) => i.id);
        await this.prisma.billableLineItem.updateMany({
          where: { id: { in: itemIds } },
          data: { walletDebitedAt: new Date() },
        });
        itemsDebited += items.length;
        teamsProcessed++;
        continue;
      }

      const idempotencyKey = this.buildBatchIdempotencyKey(
        firstItem.teamId,
        firstItem.appId,
        items,
      );

      try {
        await this.ledgerService.createEntry({
          appId: firstItem.appId,
          billToId: firstItem.billToId,
          accountType: "WALLET",
          type: "USAGE_CHARGE",
          amountMinor: -totalAmount, // Negative = debit
          currency: firstItem.currency,
          referenceType: "USAGE_EVENT",
          referenceId: undefined,
          idempotencyKey,
          metadata: {
            mode: "batch",
            lineItemCount: items.length,
            lineItemIds: items.map((i) => i.id),
            totalAmount,
          },
        });

        entriesCreated++;
      } catch (err: unknown) {
        if (err instanceof DuplicateLedgerEntryError) {
          // Already processed — still mark items as debited
        } else {
          throw err;
        }
      }

      const itemIds = items.map((i) => i.id);
      await this.prisma.billableLineItem.updateMany({
        where: { id: { in: itemIds } },
        data: { walletDebitedAt: new Date() },
      });

      itemsDebited += items.length;
      teamsProcessed++;

      await this.topupService.checkAndTriggerAutoTopUp(
        firstItem.appId,
        firstItem.teamId,
      );
    }

    return { teamsProcessed, entriesCreated, itemsDebited };
  }

  private async createDebitEntry(lineItem: BillableLineItem): Promise<string> {
    const idempotencyKey = `wallet-debit:${lineItem.id}`;

    try {
      return await this.ledgerService.createEntry({
        appId: lineItem.appId,
        billToId: lineItem.billToId,
        accountType: "WALLET",
        type: "USAGE_CHARGE",
        amountMinor: -lineItem.amountMinor, // Negative = debit
        currency: lineItem.currency,
        referenceType: "USAGE_EVENT",
        referenceId: lineItem.usageEventId ?? undefined,
        idempotencyKey,
        metadata: {
          mode: "immediate",
          lineItemId: lineItem.id,
          description: lineItem.description,
        },
      });
    } catch (err: unknown) {
      if (err instanceof DuplicateLedgerEntryError) {
        return "duplicate";
      }
      throw err;
    }
  }

  /**
   * Build a deterministic idempotency key for a batch debit by sorting
   * and hashing line item IDs. This ensures re-processing the same batch
   * does not create duplicate ledger entries.
   */
  private buildBatchIdempotencyKey(
    teamId: string,
    appId: string,
    items: Array<{ id: string }>,
  ): string {
    const sortedIds = items.map((i) => i.id).sort();
    return `wallet-batch:${teamId}:${appId}:${sortedIds.join(",")}`;
  }
}
