import { describe, it, expect, vi, beforeEach } from "vitest";
import { LedgerService, DuplicateLedgerEntryError } from "./ledger.service.js";

// --- Mocks ---

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    ledgerAccount: { findUnique: vi.fn(), create: vi.fn() },
    ledgerEntry: { create: vi.fn() },
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
    it("creates a ledger entry successfully", async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
        id: "la-001",
      });
      mockPrisma.ledgerEntry.create.mockResolvedValue({
        id: "le-001",
        idempotencyKey: "key-1",
      });

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
      expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({
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
      mockPrisma.ledgerEntry.create.mockRejectedValue({
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
      mockPrisma.ledgerEntry.create.mockResolvedValue({
        id: "le-002",
      });

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

      expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          referenceId: undefined,
        }),
      });
    });
  });
});
