import { describe, it, expect, vi, beforeEach } from "vitest";
import { v4 as uuidv4 } from "uuid";

const TEST_APP_ID = uuidv4();
const TEST_TEAM_ID = uuidv4();
const TEST_BILL_TO_ID = uuidv4();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    billableLineItem: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    team: { findUnique: vi.fn() },
    priceBook: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/stripe.js", () => ({
  getStripeClient: () => ({
    paymentIntents: { create: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_test" }) },
  }),
  resetStripeClient: vi.fn(),
}));

import { WalletDebitService } from "./wallet-debit.service.js";
import { LedgerService, DuplicateLedgerEntryError } from "./ledger.service.js";
import { TopupService } from "./topup.service.js";

function makeLineItem(overrides: Record<string, unknown> = {}) {
  return {
    id: uuidv4(),
    appId: TEST_APP_ID,
    billToId: TEST_BILL_TO_ID,
    teamId: TEST_TEAM_ID,
    userId: null,
    usageEventId: uuidv4(),
    timestamp: new Date(),
    priceBookId: uuidv4(),
    priceRuleId: uuidv4(),
    amountMinor: 100,
    currency: "usd",
    description: "Customer pricing: llm.tokens.v1 (per_unit)",
    inputsSnapshot: {},
    walletDebitedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("WalletDebitService", () => {
  let service: WalletDebitService;
  let mockLedgerService: {
    createEntry: ReturnType<typeof vi.fn>;
    getBalance: ReturnType<typeof vi.fn>;
    getOrCreateAccount: ReturnType<typeof vi.fn>;
  };
  let mockTopupService: {
    checkAndTriggerAutoTopUp: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockLedgerService = {
      createEntry: vi.fn().mockResolvedValue("entry-id"),
      getBalance: vi.fn().mockResolvedValue(0),
      getOrCreateAccount: vi.fn().mockResolvedValue("account-id"),
    };

    mockTopupService = {
      checkAndTriggerAutoTopUp: vi.fn().mockResolvedValue(false),
    };

    service = new WalletDebitService(
      mockPrisma as unknown as import("@prisma/client").PrismaClient,
      mockLedgerService as unknown as LedgerService,
      mockTopupService as unknown as TopupService,
    );
  });

  describe("debitImmediate", () => {
    it("creates a USAGE_CHARGE ledger entry for a WALLET-mode team", async () => {
      const lineItem = makeLineItem();

      mockPrisma.billableLineItem.findUnique.mockResolvedValue(lineItem);
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.priceBook.findUnique.mockResolvedValue({
        id: lineItem.priceBookId,
        kind: "CUSTOMER",
      });
      mockPrisma.billableLineItem.update.mockResolvedValue({
        ...lineItem,
        walletDebitedAt: new Date(),
      });

      const entryId = await service.debitImmediate(lineItem.id);

      expect(entryId).toBe("entry-id");
      expect(mockLedgerService.createEntry).toHaveBeenCalledWith({
        appId: TEST_APP_ID,
        billToId: TEST_BILL_TO_ID,
        accountType: "WALLET",
        type: "USAGE_CHARGE",
        amountMinor: -100,
        currency: "usd",
        referenceType: "USAGE_EVENT",
        referenceId: lineItem.usageEventId,
        idempotencyKey: `wallet-debit:${lineItem.id}`,
        metadata: {
          mode: "immediate",
          lineItemId: lineItem.id,
          description: lineItem.description,
        },
      });
    });

    it("marks the line item as debited after creating the entry", async () => {
      const lineItem = makeLineItem();

      mockPrisma.billableLineItem.findUnique.mockResolvedValue(lineItem);
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.priceBook.findUnique.mockResolvedValue({
        id: lineItem.priceBookId,
        kind: "CUSTOMER",
      });
      mockPrisma.billableLineItem.update.mockResolvedValue({
        ...lineItem,
        walletDebitedAt: new Date(),
      });

      await service.debitImmediate(lineItem.id);

      expect(mockPrisma.billableLineItem.update).toHaveBeenCalledWith({
        where: { id: lineItem.id },
        data: { walletDebitedAt: expect.any(Date) },
      });
    });

    it("triggers auto-top-up after debit", async () => {
      const lineItem = makeLineItem();

      mockPrisma.billableLineItem.findUnique.mockResolvedValue(lineItem);
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.priceBook.findUnique.mockResolvedValue({
        id: lineItem.priceBookId,
        kind: "CUSTOMER",
      });
      mockPrisma.billableLineItem.update.mockResolvedValue({
        ...lineItem,
        walletDebitedAt: new Date(),
      });

      await service.debitImmediate(lineItem.id);

      expect(mockTopupService.checkAndTriggerAutoTopUp).toHaveBeenCalledWith(
        TEST_APP_ID,
        TEST_TEAM_ID,
      );
    });

    it("returns null for nonexistent line item", async () => {
      mockPrisma.billableLineItem.findUnique.mockResolvedValue(null);

      const result = await service.debitImmediate("nonexistent-id");

      expect(result).toBeNull();
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("returns null for already-debited line item", async () => {
      const lineItem = makeLineItem({ walletDebitedAt: new Date() });

      mockPrisma.billableLineItem.findUnique.mockResolvedValue(lineItem);

      const result = await service.debitImmediate(lineItem.id);

      expect(result).toBeNull();
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("returns null for non-WALLET billing mode team", async () => {
      const lineItem = makeLineItem();

      mockPrisma.billableLineItem.findUnique.mockResolvedValue(lineItem);
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "SUBSCRIPTION",
      });

      const result = await service.debitImmediate(lineItem.id);

      expect(result).toBeNull();
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("skips COGS line items", async () => {
      const lineItem = makeLineItem();

      mockPrisma.billableLineItem.findUnique.mockResolvedValue(lineItem);
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.priceBook.findUnique.mockResolvedValue({
        id: lineItem.priceBookId,
        kind: "COGS",
      });

      const result = await service.debitImmediate(lineItem.id);

      expect(result).toBeNull();
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("handles duplicate idempotency key gracefully", async () => {
      const lineItem = makeLineItem();

      mockPrisma.billableLineItem.findUnique.mockResolvedValue(lineItem);
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.priceBook.findUnique.mockResolvedValue({
        id: lineItem.priceBookId,
        kind: "CUSTOMER",
      });
      mockPrisma.billableLineItem.update.mockResolvedValue({
        ...lineItem,
        walletDebitedAt: new Date(),
      });
      mockLedgerService.createEntry.mockRejectedValue(
        new DuplicateLedgerEntryError(`wallet-debit:${lineItem.id}`),
      );

      const result = await service.debitImmediate(lineItem.id);

      expect(result).toBe("duplicate");
    });

    it("creates a negative amountMinor for the debit entry", async () => {
      const lineItem = makeLineItem({ amountMinor: 500 });

      mockPrisma.billableLineItem.findUnique.mockResolvedValue(lineItem);
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.priceBook.findUnique.mockResolvedValue({
        id: lineItem.priceBookId,
        kind: "CUSTOMER",
      });
      mockPrisma.billableLineItem.update.mockResolvedValue({
        ...lineItem,
        walletDebitedAt: new Date(),
      });

      await service.debitImmediate(lineItem.id);

      expect(mockLedgerService.createEntry).toHaveBeenCalledWith(
        expect.objectContaining({ amountMinor: -500 }),
      );
    });
  });

  describe("debitBatch", () => {
    it("aggregates undebited CUSTOMER line items per team", async () => {
      const items = [
        makeLineItem({ amountMinor: 100 }),
        makeLineItem({ amountMinor: 200 }),
        makeLineItem({ amountMinor: 300 }),
      ];

      mockPrisma.billableLineItem.findMany.mockResolvedValue(
        items.map((item) => ({ ...item, priceBook: { kind: "CUSTOMER" } })),
      );
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.billableLineItem.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.debitBatch();

      expect(result.teamsProcessed).toBe(1);
      expect(result.entriesCreated).toBe(1);
      expect(result.itemsDebited).toBe(3);

      expect(mockLedgerService.createEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          amountMinor: -600,
          type: "USAGE_CHARGE",
          accountType: "WALLET",
        }),
      );
    });

    it("marks all batch items as debited", async () => {
      const items = [
        makeLineItem({ amountMinor: 100 }),
        makeLineItem({ amountMinor: 200 }),
      ];

      mockPrisma.billableLineItem.findMany.mockResolvedValue(
        items.map((item) => ({ ...item, priceBook: { kind: "CUSTOMER" } })),
      );
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.billableLineItem.updateMany.mockResolvedValue({ count: 2 });

      await service.debitBatch();

      expect(mockPrisma.billableLineItem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: items.map((i) => i.id) } },
        data: { walletDebitedAt: expect.any(Date) },
      });
    });

    it("skips non-WALLET teams", async () => {
      const items = [makeLineItem()];

      mockPrisma.billableLineItem.findMany.mockResolvedValue(
        items.map((item) => ({ ...item, priceBook: { kind: "CUSTOMER" } })),
      );
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "SUBSCRIPTION",
      });

      const result = await service.debitBatch();

      expect(result.teamsProcessed).toBe(0);
      expect(result.entriesCreated).toBe(0);
      expect(result.itemsDebited).toBe(0);
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("filters out COGS line items from batch", async () => {
      const customerItem = makeLineItem({ amountMinor: 100 });
      const cogsItem = makeLineItem({ amountMinor: 50 });

      mockPrisma.billableLineItem.findMany.mockResolvedValue([
        { ...customerItem, priceBook: { kind: "CUSTOMER" } },
        { ...cogsItem, priceBook: { kind: "COGS" } },
      ]);
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.billableLineItem.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.debitBatch();

      expect(result.itemsDebited).toBe(1);
      expect(mockLedgerService.createEntry).toHaveBeenCalledWith(
        expect.objectContaining({ amountMinor: -100 }),
      );
    });

    it("returns zeros when no undebited items exist", async () => {
      mockPrisma.billableLineItem.findMany.mockResolvedValue([]);

      const result = await service.debitBatch();

      expect(result.teamsProcessed).toBe(0);
      expect(result.entriesCreated).toBe(0);
      expect(result.itemsDebited).toBe(0);
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("is idempotent — does not double-debit on duplicate key", async () => {
      const items = [makeLineItem({ amountMinor: 100 })];

      mockPrisma.billableLineItem.findMany.mockResolvedValue(
        items.map((item) => ({ ...item, priceBook: { kind: "CUSTOMER" } })),
      );
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockLedgerService.createEntry.mockRejectedValue(
        new DuplicateLedgerEntryError("wallet-batch:test"),
      );
      mockPrisma.billableLineItem.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.debitBatch();

      // Still marks items as debited even on duplicate key
      expect(result.teamsProcessed).toBe(1);
      expect(result.itemsDebited).toBe(1);
      expect(mockPrisma.billableLineItem.updateMany).toHaveBeenCalled();
    });

    it("triggers auto-top-up after batch debit", async () => {
      const items = [makeLineItem({ amountMinor: 100 })];

      mockPrisma.billableLineItem.findMany.mockResolvedValue(
        items.map((item) => ({ ...item, priceBook: { kind: "CUSTOMER" } })),
      );
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.billableLineItem.updateMany.mockResolvedValue({ count: 1 });

      await service.debitBatch();

      expect(mockTopupService.checkAndTriggerAutoTopUp).toHaveBeenCalledWith(
        TEST_APP_ID,
        TEST_TEAM_ID,
      );
    });

    it("processes multiple teams independently", async () => {
      const team2Id = uuidv4();
      const billTo2Id = uuidv4();
      const items = [
        makeLineItem({ amountMinor: 100 }),
        makeLineItem({
          teamId: team2Id,
          billToId: billTo2Id,
          amountMinor: 200,
        }),
      ];

      mockPrisma.billableLineItem.findMany.mockResolvedValue(
        items.map((item) => ({ ...item, priceBook: { kind: "CUSTOMER" } })),
      );
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.billableLineItem.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.debitBatch();

      expect(result.teamsProcessed).toBe(2);
      expect(result.entriesCreated).toBe(2);
      expect(result.itemsDebited).toBe(2);
    });

    it("batch debit entries reference correct BillableLineItem IDs in metadata", async () => {
      const items = [
        makeLineItem({ amountMinor: 100 }),
        makeLineItem({ amountMinor: 200 }),
      ];

      mockPrisma.billableLineItem.findMany.mockResolvedValue(
        items.map((item) => ({ ...item, priceBook: { kind: "CUSTOMER" } })),
      );
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.billableLineItem.updateMany.mockResolvedValue({ count: 2 });

      await service.debitBatch();

      const createEntryCall = mockLedgerService.createEntry.mock.calls[0][0];
      expect(createEntryCall.metadata.lineItemIds).toEqual(
        expect.arrayContaining([items[0].id, items[1].id]),
      );
      expect(createEntryCall.metadata.lineItemCount).toBe(2);
      expect(createEntryCall.metadata.mode).toBe("batch");
    });

    it("handles zero-amount batch gracefully", async () => {
      const items = [
        makeLineItem({ amountMinor: 0 }),
        makeLineItem({ amountMinor: 0 }),
      ];

      mockPrisma.billableLineItem.findMany.mockResolvedValue(
        items.map((item) => ({ ...item, priceBook: { kind: "CUSTOMER" } })),
      );
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        billingMode: "WALLET",
      });
      mockPrisma.billableLineItem.updateMany.mockResolvedValue({ count: 2 });

      const result = await service.debitBatch();

      // Zero-amount items should still be marked as debited
      expect(result.teamsProcessed).toBe(1);
      expect(result.itemsDebited).toBe(2);
      // No ledger entry needed for zero amount
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });
  });
});
