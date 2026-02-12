import { describe, it, expect, vi, beforeEach } from "vitest";
import PgBoss from "pg-boss";
import {
  PeriodCloseWorker,
  PERIOD_CLOSE_QUEUE,
} from "./period-close.worker.js";
import { PeriodCloseService } from "../services/period-close.service.js";

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => ({}),
  disconnectPrisma: vi.fn(),
}));

describe("PeriodCloseWorker", () => {
  let worker: PeriodCloseWorker;
  let mockService: {
    runPeriodClose: ReturnType<typeof vi.fn>;
  };
  let mockBoss: {
    createQueue: ReturnType<typeof vi.fn>;
    work: ReturnType<typeof vi.fn>;
    schedule: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockService = {
      runPeriodClose: vi.fn().mockResolvedValue({
        processed: 0,
        skipped: 0,
        failed: 0,
        invoices: [],
        errors: [],
      }),
    };

    mockBoss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
    };

    worker = new PeriodCloseWorker(
      mockService as unknown as PeriodCloseService,
    );
  });

  it("registers the queue and schedules a daily cron job", async () => {
    await worker.start(mockBoss as unknown as PgBoss);

    expect(mockBoss.createQueue).toHaveBeenCalledWith(PERIOD_CLOSE_QUEUE);
    expect(mockBoss.work).toHaveBeenCalledWith(
      PERIOD_CLOSE_QUEUE,
      expect.objectContaining({ pollingIntervalSeconds: 60 }),
      expect.any(Function),
    );
    expect(mockBoss.schedule).toHaveBeenCalledWith(
      PERIOD_CLOSE_QUEUE,
      "0 1 * * *",
    );
  });

  it("calls runPeriodClose when processing", async () => {
    mockService.runPeriodClose.mockResolvedValue({
      processed: 2,
      skipped: 1,
      failed: 0,
      invoices: [
        {
          contractId: "c1",
          invoiceId: "inv1",
          status: "ISSUED",
          lineItemCount: 3,
          totalMinor: 5000,
        },
        {
          contractId: "c2",
          invoiceId: "inv2",
          status: "DRAFT",
          lineItemCount: 1,
          totalMinor: 0,
        },
      ],
      errors: [],
    });

    const result = await worker.processPeriodClose();

    expect(mockService.runPeriodClose).toHaveBeenCalled();
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.invoices).toHaveLength(2);
  });

  it("throws when pg-boss is not initialized", async () => {
    vi.mock("../lib/pg-boss.js", () => ({
      getBoss: () => undefined,
    }));

    const workerNoBoss = new PeriodCloseWorker(
      mockService as unknown as PeriodCloseService,
    );

    await expect(workerNoBoss.start()).rejects.toThrow(
      "pg-boss is not initialized",
    );
  });

  it("returns zero results when no contracts to process", async () => {
    const result = await worker.processPeriodClose();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.invoices).toHaveLength(0);
  });

  it("uses custom polling interval when provided", async () => {
    const customWorker = new PeriodCloseWorker(
      mockService as unknown as PeriodCloseService,
      { pollingIntervalSeconds: 120 },
    );

    await customWorker.start(mockBoss as unknown as PgBoss);

    expect(mockBoss.work).toHaveBeenCalledWith(
      PERIOD_CLOSE_QUEUE,
      expect.objectContaining({ pollingIntervalSeconds: 120 }),
      expect.any(Function),
    );
  });
});
