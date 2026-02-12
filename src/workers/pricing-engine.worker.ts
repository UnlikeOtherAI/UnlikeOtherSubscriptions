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
const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;

export interface PricingWorkerOptions {
  batchSize?: number;
  pollingIntervalSeconds?: number;
  maxRetries?: number;
}

export class PricingEngineWorker {
  private prisma: PrismaClient;
  private engine: PricingEngine;
  private batchSize: number;
  private pollingIntervalSeconds: number;
  private maxRetries: number;

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
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
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
    const now = new Date();
    const unpricedEvents = await this.prisma.usageEvent.findMany({
      where: {
        pricedAt: null,
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: now } },
        ],
      },
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
          await this.scheduleTransientRetry(event, err as Error);
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

  private async scheduleTransientRetry(
    event: UsageEvent,
    error: Error,
  ): Promise<void> {
    const nextRetryCount = event.retryCount + 1;

    if (nextRetryCount > this.maxRetries) {
      console.error(
        `[pricing-worker] Max retries (${this.maxRetries}) exceeded for event ${event.id}: ${error.message}`,
      );
      await this.flagFailedEvent(event, error);
      return;
    }

    const backoffMs = computeBackoffMs(nextRetryCount);
    const nextRetryAt = new Date(Date.now() + backoffMs);

    console.warn(
      `[pricing-worker] Transient failure for event ${event.id} (retry ${nextRetryCount}/${this.maxRetries}), next retry at ${nextRetryAt.toISOString()}: ${error.message}`,
    );

    await this.prisma.usageEvent.update({
      where: { id: event.id },
      data: { retryCount: nextRetryCount, nextRetryAt },
    });
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

export function computeBackoffMs(retryCount: number): number {
  return BACKOFF_BASE_MS * Math.pow(2, retryCount - 1);
}
