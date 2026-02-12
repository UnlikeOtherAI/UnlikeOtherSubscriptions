import PgBoss from "pg-boss";
import { PrismaClient, Prisma, UsageEvent } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";
import { getBoss } from "../lib/pg-boss.js";
import {
  PricingEngine,
  NoPriceBookFoundError,
  NoMatchingRuleError,
  InvalidRuleError,
} from "../services/pricing-engine.service.js";

export const PRICING_WORKER_QUEUE = "pricing-engine";
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export interface PricingWorkerOptions {
  batchSize?: number;
  pollingIntervalSeconds?: number;
}

export class PricingEngineWorker {
  private prisma: PrismaClient;
  private engine: PricingEngine;
  private batchSize: number;
  private pollingIntervalSeconds: number;

  constructor(
    prisma?: PrismaClient,
    engine?: PricingEngine,
    options: PricingWorkerOptions = {},
  ) {
    this.prisma = prisma ?? getPrismaClient();
    this.engine = engine ?? new PricingEngine(this.prisma);
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.pollingIntervalSeconds =
      options.pollingIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  }

  async start(boss?: PgBoss): Promise<void> {
    const pgBoss = boss ?? getBoss();
    if (!pgBoss) {
      throw new Error("pg-boss is not initialized");
    }

    await pgBoss.createQueue(PRICING_WORKER_QUEUE);

    await pgBoss.work<Record<string, never>>(
      PRICING_WORKER_QUEUE,
      { pollingIntervalSeconds: this.pollingIntervalSeconds },
      async () => {
        await this.processUnpricedEvents();
      },
    );

    await pgBoss.schedule(PRICING_WORKER_QUEUE, `* * * * *`);
  }

  async processUnpricedEvents(): Promise<{
    processed: number;
    skipped: number;
    failed: number;
  }> {
    const unpricedEvents = await this.prisma.usageEvent.findMany({
      where: { pricedAt: null },
      orderBy: { createdAt: "asc" },
      take: this.batchSize,
    });

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const event of unpricedEvents) {
      try {
        const wasProcessed = await this.priceEventWithTransaction(event);
        if (wasProcessed) {
          processed++;
        } else {
          skipped++;
        }
      } catch (err) {
        if (this.isPermanentFailure(err)) {
          await this.flagFailedEvent(event, err as Error);
          failed++;
        } else {
          failed++;
        }
      }
    }

    return { processed, skipped, failed };
  }

  private async priceEventWithTransaction(
    event: UsageEvent,
  ): Promise<boolean> {
    // Check if already priced (idempotency guard)
    const existing = await this.prisma.billableLineItem.findFirst({
      where: { usageEventId: event.id },
      select: { id: true },
    });

    if (existing) {
      // Already priced — mark pricedAt if not yet set (recovery path)
      if (!event.pricedAt) {
        await this.prisma.usageEvent.update({
          where: { id: event.id },
          data: { pricedAt: new Date() },
        });
      }
      return false;
    }

    const result = await this.engine.priceEvent(event);

    await this.prisma.$transaction(async (tx) => {
      for (const item of result.lineItems) {
        await tx.billableLineItem.create({
          data: {
            appId: item.appId,
            billToId: item.billToId,
            teamId: item.teamId,
            userId: item.userId,
            usageEventId: item.usageEventId,
            timestamp: item.timestamp,
            priceBookId: item.priceBookId,
            priceRuleId: item.priceRuleId,
            amountMinor: item.amountMinor,
            currency: item.currency,
            description: item.description,
            inputsSnapshot:
              item.inputsSnapshot as Prisma.InputJsonValue,
          },
        });
      }

      await tx.usageEvent.update({
        where: { id: event.id },
        data: { pricedAt: new Date() },
      });
    });

    return true;
  }

  private isPermanentFailure(err: unknown): boolean {
    return (
      err instanceof NoPriceBookFoundError ||
      err instanceof NoMatchingRuleError ||
      err instanceof InvalidRuleError
    );
  }

  private async flagFailedEvent(
    event: UsageEvent,
    error: Error,
  ): Promise<void> {
    console.error(
      `[pricing-worker] Permanent failure for event ${event.id}: ${error.message}`,
    );

    await this.prisma.usageEvent.update({
      where: { id: event.id },
      data: { pricedAt: new Date() },
    });
  }
}
