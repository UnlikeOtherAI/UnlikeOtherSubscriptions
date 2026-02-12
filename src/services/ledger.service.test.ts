import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LedgerService,
  DuplicateLedgerEntryError,
  TeamNotFoundError,
  BillingEntityNotFoundError,
} from "./ledger.service.js";

// --- Mocks ---

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    ledgerAccount: { findUnique: vi.fn(), create: vi.fn() },
    ledgerEntry: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    team: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

// --- Tests ---

describe("LedgerService", () => {
  let service: LedgerService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LedgerService();
  });

  describe("getOrCreateAccount", () => {
    it("returns existing account id", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
        id: "la-existing",
        appId: "app-1",
        billToId: "be-1",
        type: "REVENUE",
      });

      const id = await service.getOrCreateAccount("app-1", "be-1", "REVENUE");
      expect(id).toBe("la-existing");
      expect(mockPrisma.ledgerAccount.create).not.toHaveBeenCalled();
    });

    it("creates account if not found", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue(null);
      mockPrisma.ledgerAccount.create.mockResolvedValue({
        id: "la-new",
        appId: "app-1",
        billToId: "be-1",
        type: "WALLET",
      });

      const id = await service.getOrCreateAccount("app-1", "be-1", "WALLET");
      expect(id).toBe("la-new");
      expect(mockPrisma.ledgerAccount.create).toHaveBeenCalledWith({
        data: { appId: "app-1", billToId: "be-1", type: "WALLET" },
      });
    });

    it("handles race condition on concurrent create", async () => {
      mockPrisma.ledgerAccount.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "la-race",
          appId: "app-1",
          billToId: "be-1",
          type: "REVENUE",
        });

      mockPrisma.ledgerAccount.create.mockRejectedValue({
        code: "P2002",
        meta: { target: ["appId_billToId_type"] },
      });

      const id = await service.getOrCreateAccount("app-1", "be-1", "REVENUE");
      expect(id).toBe("la-race");
    });
  });

  describe("createEntry", () => {
    it("creates a ledger entry within a transaction with advisory lock", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
        id: "la-001",
      });

      const mockTx = {
        $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
        ledgerEntry: {
          create: vi.fn().mockResolvedValue({
            id: "le-001",
            idempotencyKey: "key-1",
          }),
        },
      };
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
      );

      const entryId = await service.createEntry({
        appId: "app-1",
        billToId: "be-1",
        accountType: "REVENUE",
        type: "SUBSCRIPTION_CHARGE",
        amountMinor: 2999,
        currency: "usd",
        referenceType: "STRIPE_INVOICE",
        referenceId: "in_123",
        idempotencyKey: "key-1",
        metadata: { test: true },
      });

      expect(entryId).toBe("le-001");
      expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
        "SELECT pg_advisory_xact_lock($1)",
        expect.any(Number),
      );
      expect(mockTx.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          appId: "app-1",
          billToId: "be-1",
          ledgerAccountId: "la-001",
          type: "SUBSCRIPTION_CHARGE",
          amountMinor: 2999,
          currency: "usd",
          referenceType: "STRIPE_INVOICE",
          referenceId: "in_123",
          idempotencyKey: "key-1",
          metadata: { test: true },
        }),
      });
    });

    it("throws DuplicateLedgerEntryError on duplicate idempotency key", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
        id: "la-001",
      });
      mockPrisma.$transaction.mockRejectedValue({
        code: "P2002",
        meta: { target: ["idempotencyKey"] },
      });

      await expect(
        service.createEntry({
          appId: "app-1",
          billToId: "be-1",
          accountType: "REVENUE",
          type: "SUBSCRIPTION_CHARGE",
          amountMinor: 2999,
          currency: "usd",
          referenceType: "STRIPE_INVOICE",
          idempotencyKey: "duplicate-key",
        }),
      ).rejects.toThrow(DuplicateLedgerEntryError);
    });

    it("stores null for optional fields when not provided", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
        id: "la-001",
      });

      const mockTx = {
        $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
        ledgerEntry: {
          create: vi.fn().mockResolvedValue({ id: "le-002" }),
        },
      };
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
      );

      await service.createEntry({
        appId: "app-1",
        billToId: "be-1",
        accountType: "REVENUE",
        type: "TOPUP",
        amountMinor: 5000,
        currency: "gbp",
        referenceType: "STRIPE_PAYMENT_INTENT",
        idempotencyKey: "key-2",
      });

      expect(mockTx.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          referenceId: undefined,
        }),
      });
    });
  });

  describe("getBalance", () => {
    it("returns 0 when no account exists", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue(null);

      const balance = await service.getBalance("app-1", "be-1", "WALLET");
      expect(balance).toBe(0);
    });

    it("returns sum of amountMinor for existing account", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
        id: "la-001",
      });
      mockPrisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amountMinor: 15000 },
      });

      const balance = await service.getBalance("app-1", "be-1", "WALLET");
      expect(balance).toBe(15000);
      expect(mockPrisma.ledgerEntry.aggregate).toHaveBeenCalledWith({
        where: { ledgerAccountId: "la-001" },
        _sum: { amountMinor: true },
      });
    });

    it("returns 0 when account has no entries", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
        id: "la-001",
      });
      mockPrisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amountMinor: null },
      });

      const balance = await service.getBalance("app-1", "be-1", "WALLET");
      expect(balance).toBe(0);
    });

    it("returns correct balance after credits and debits", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
        id: "la-001",
      });
      mockPrisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amountMinor: 7000 },
      });

      const balance = await service.getBalance("app-1", "be-1", "WALLET");
      expect(balance).toBe(7000);
    });
  });

  describe("getEntries", () => {
    it("returns entries with defaults when no filters", async () => {
      const mockEntries = [
        { id: "le-1", amountMinor: 1000, type: "TOPUP" },
        { id: "le-2", amountMinor: -500, type: "USAGE_CHARGE" },
      ];
      mockPrisma.ledgerEntry.findMany.mockResolvedValue(mockEntries);
      mockPrisma.ledgerEntry.count.mockResolvedValue(2);

      const result = await service.getEntries("app-1", "be-1");

      expect(result.entries).toEqual(mockEntries);
      expect(result.total).toBe(2);
      expect(mockPrisma.ledgerEntry.findMany).toHaveBeenCalledWith({
        where: { appId: "app-1", billToId: "be-1" },
        orderBy: { timestamp: "desc" },
        take: 50,
        skip: 0,
      });
    });

    it("applies date range filter", async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
      mockPrisma.ledgerEntry.count.mockResolvedValue(0);

      const from = new Date("2024-01-01T00:00:00Z");
      const to = new Date("2024-01-31T23:59:59Z");

      await service.getEntries("app-1", "be-1", { from, to });

      expect(mockPrisma.ledgerEntry.findMany).toHaveBeenCalledWith({
        where: {
          appId: "app-1",
          billToId: "be-1",
          timestamp: { gte: from, lte: to },
        },
        orderBy: { timestamp: "desc" },
        take: 50,
        skip: 0,
      });
    });

    it("applies type filter", async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
      mockPrisma.ledgerEntry.count.mockResolvedValue(0);

      await service.getEntries("app-1", "be-1", { type: "TOPUP" });

      expect(mockPrisma.ledgerEntry.findMany).toHaveBeenCalledWith({
        where: {
          appId: "app-1",
          billToId: "be-1",
          type: "TOPUP",
        },
        orderBy: { timestamp: "desc" },
        take: 50,
        skip: 0,
      });
    });

    it("applies pagination with limit and offset", async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
      mockPrisma.ledgerEntry.count.mockResolvedValue(100);

      await service.getEntries("app-1", "be-1", {
        limit: 20,
        offset: 40,
      });

      expect(mockPrisma.ledgerEntry.findMany).toHaveBeenCalledWith({
        where: { appId: "app-1", billToId: "be-1" },
        orderBy: { timestamp: "desc" },
        take: 20,
        skip: 40,
      });
    });

    it("applies all filters together", async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
      mockPrisma.ledgerEntry.count.mockResolvedValue(5);

      const from = new Date("2024-06-01");
      const to = new Date("2024-06-30");

      await service.getEntries("app-1", "be-1", {
        from,
        to,
        type: "SUBSCRIPTION_CHARGE",
        limit: 10,
        offset: 0,
      });

      expect(mockPrisma.ledgerEntry.findMany).toHaveBeenCalledWith({
        where: {
          appId: "app-1",
          billToId: "be-1",
          timestamp: { gte: from, lte: to },
          type: "SUBSCRIPTION_CHARGE",
        },
        orderBy: { timestamp: "desc" },
        take: 10,
        skip: 0,
      });
    });
  });

  describe("resolveBillToId", () => {
    it("returns billToId for a team with billing entity", async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: "team-1",
        billingEntity: { id: "be-1" },
      });

      const billToId = await service.resolveBillToId("team-1");
      expect(billToId).toBe("be-1");
    });

    it("throws TeamNotFoundError for nonexistent team", async () => {
      mockPrisma.team.findUnique.mockResolvedValue(null);

      await expect(service.resolveBillToId("team-999")).rejects.toThrow(
        TeamNotFoundError,
      );
    });

    it("throws BillingEntityNotFoundError when no billing entity", async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: "team-1",
        billingEntity: null,
      });

      await expect(service.resolveBillToId("team-1")).rejects.toThrow(
        BillingEntityNotFoundError,
      );
    });
  });
});
