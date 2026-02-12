import { describe, it, expect, vi, beforeEach } from "vitest";
import PgBoss from "pg-boss";
import { WalletDebitWorker, WALLET_DEBIT_QUEUE } from "./wallet-debit.worker.js";
import { WalletDebitService } from "../services/wallet-debit.service.js";

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => ({}),
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/stripe.js", () => ({
  getStripeClient: () => ({
    paymentIntents: { create: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    customers: { create: vi.fn() },
  }),
  resetStripeClient: vi.fn(),
}));

describe("WalletDebitWorker", () => {
  let worker: WalletDebitWorker;
  let mockDebitService: {
    debitBatch: ReturnType<typeof vi.fn>;
  };
  let mockBoss: {
    createQueue: ReturnType<typeof vi.fn>;
    work: ReturnType<typeof vi.fn>;
    schedule: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockDebitService = {
      debitBatch: vi.fn().mockResolvedValue({
        teamsProcessed: 0,
        entriesCreated: 0,
        itemsDebited: 0,
      }),
    };

    mockBoss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
    };

    worker = new WalletDebitWorker(
      mockDebitService as unknown as WalletDebitService,
    );
  });

  it("registers the queue and schedules a daily cron job", async () => {
    await worker.start(mockBoss as unknown as PgBoss);

    expect(mockBoss.createQueue).toHaveBeenCalledWith(WALLET_DEBIT_QUEUE);
    expect(mockBoss.work).toHaveBeenCalledWith(
      WALLET_DEBIT_QUEUE,
      expect.objectContaining({ pollingIntervalSeconds: 60 }),
      expect.any(Function),
    );
    expect(mockBoss.schedule).toHaveBeenCalledWith(
      WALLET_DEBIT_QUEUE,
      "0 0 * * *",
    );
  });

  it("calls debitBatch when processing", async () => {
    mockDebitService.debitBatch.mockResolvedValue({
      teamsProcessed: 2,
      entriesCreated: 2,
      itemsDebited: 5,
    });

    const result = await worker.processBatchDebits();

    expect(mockDebitService.debitBatch).toHaveBeenCalled();
    expect(result.teamsProcessed).toBe(2);
    expect(result.entriesCreated).toBe(2);
    expect(result.itemsDebited).toBe(5);
  });

  it("throws when pg-boss is not initialized", async () => {
    vi.mock("../lib/pg-boss.js", () => ({
      getBoss: () => undefined,
    }));

    const workerNoBoss = new WalletDebitWorker(
      mockDebitService as unknown as WalletDebitService,
    );

    await expect(workerNoBoss.start()).rejects.toThrow(
      "pg-boss is not initialized",
    );
  });

  it("returns zero results when no items to process", async () => {
    const result = await worker.processBatchDebits();

    expect(result.teamsProcessed).toBe(0);
    expect(result.entriesCreated).toBe(0);
    expect(result.itemsDebited).toBe(0);
  });
});
