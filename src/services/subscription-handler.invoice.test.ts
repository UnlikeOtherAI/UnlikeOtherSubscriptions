import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";
import { SubscriptionHandlerService } from "./subscription-handler.service.js";
import { DuplicateLedgerEntryError } from "./ledger.service.js";

// --- Mocks ---

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    teamSubscription: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    billingEntity: { findUnique: vi.fn() },
    plan: { findUnique: vi.fn() },
    ledgerAccount: { findUnique: vi.fn(), create: vi.fn() },
    ledgerEntry: { create: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/stripe.js", () => ({
  getStripeClient: () => ({}),
  resetStripeClient: vi.fn(),
}));

// --- Helpers ---

const TEAM_ID = "team-123";
const APP_ID = "app-456";
const PLAN_ID = "plan-789";
const BILLING_ENTITY_ID = "be-001";
const SUBSCRIPTION_ID = "sub_test_abc";

function makeStripeEvent(
  type: string,
  dataObject: Record<string, unknown>,
): Stripe.Event {
  return {
    id: `evt_${type.replace(/\./g, "_")}_${Date.now()}`,
    object: "event",
    type,
    data: { object: dataObject },
    created: Math.floor(Date.now() / 1000),
    api_version: "2024-12-18.acacia",
    livemode: false,
    pending_webhooks: 0,
    request: null,
  } as unknown as Stripe.Event;
}

function setupBillingEntityMock() {
  mockPrisma.billingEntity.findUnique.mockResolvedValue({
    id: BILLING_ENTITY_ID, type: "TEAM", teamId: TEAM_ID,
  });
}

function setupPlanMock() {
  mockPrisma.plan.findUnique.mockResolvedValue({
    id: PLAN_ID, appId: APP_ID, code: "pro", name: "Pro Plan", status: "ACTIVE",
  });
}

// --- Tests ---

describe("SubscriptionHandlerService — invoice events", () => {
  let handler: SubscriptionHandlerService;
  let mockEntitlementService: { refreshEntitlements: ReturnType<typeof vi.fn> };
  let mockLedgerService: { createEntry: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlementService = { refreshEntitlements: vi.fn().mockResolvedValue(undefined) };
    mockLedgerService = { createEntry: vi.fn().mockResolvedValue("le-001") };
    handler = new SubscriptionHandlerService(
      mockLedgerService as unknown as import("./ledger.service.js").LedgerService,
      mockEntitlementService as unknown as import("./entitlement.service.js").EntitlementService,
    );
  });

  describe("handleInvoicePaid", () => {
    it("creates correct SUBSCRIPTION_CHARGE ledger entry", async () => {
      const event = makeStripeEvent("invoice.paid", {
        id: "in_test_paid",
        subscription: SUBSCRIPTION_ID,
        amount_paid: 2999,
        currency: "usd",
      });

      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, planId: PLAN_ID,
        stripeSubscriptionId: SUBSCRIPTION_ID,
      });
      setupBillingEntityMock();
      setupPlanMock();

      await handler.handleInvoicePaid(event);

      expect(mockLedgerService.createEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: APP_ID, billToId: BILLING_ENTITY_ID,
          type: "SUBSCRIPTION_CHARGE", amountMinor: 2999,
          currency: "usd", referenceType: "STRIPE_INVOICE",
          referenceId: "in_test_paid",
          idempotencyKey: `invoice_paid:${event.id}`,
        }),
      );
    });

    it("skips invoices without a subscription", async () => {
      const event = makeStripeEvent("invoice.paid", {
        id: "in_no_sub", subscription: null,
        amount_paid: 500, currency: "usd",
      });
      await handler.handleInvoicePaid(event);
      expect(mockPrisma.teamSubscription.findUnique).not.toHaveBeenCalled();
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("skips if TeamSubscription is not found", async () => {
      const event = makeStripeEvent("invoice.paid", {
        id: "in_missing_sub", subscription: "sub_unknown",
        amount_paid: 999, currency: "usd",
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue(null);
      await handler.handleInvoicePaid(event);
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("skips if billing entity is not found", async () => {
      const event = makeStripeEvent("invoice.paid", {
        id: "in_no_be", subscription: SUBSCRIPTION_ID,
        amount_paid: 999, currency: "usd",
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, planId: PLAN_ID,
      });
      mockPrisma.billingEntity.findUnique.mockResolvedValue(null);
      await handler.handleInvoicePaid(event);
      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("is idempotent — duplicate ledger entries silently ignored", async () => {
      const event = makeStripeEvent("invoice.paid", {
        id: "in_dup", subscription: SUBSCRIPTION_ID,
        amount_paid: 2999, currency: "usd",
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, planId: PLAN_ID,
      });
      setupBillingEntityMock();
      setupPlanMock();
      mockLedgerService.createEntry.mockRejectedValue(
        new DuplicateLedgerEntryError("invoice_paid:test"),
      );
      await handler.handleInvoicePaid(event);
    });

    it("propagates non-duplicate ledger errors instead of swallowing them", async () => {
      const event = makeStripeEvent("invoice.paid", {
        id: "in_err", subscription: SUBSCRIPTION_ID,
        amount_paid: 2999, currency: "usd",
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, planId: PLAN_ID,
      });
      setupBillingEntityMock();
      setupPlanMock();
      mockLedgerService.createEntry.mockRejectedValue(new Error("DB connection lost"));

      await expect(handler.handleInvoicePaid(event)).rejects.toThrow("DB connection lost");
    });
  });

  describe("handleInvoicePaymentFailed", () => {
    it("creates ADJUSTMENT ledger entry for failed payment", async () => {
      const event = makeStripeEvent("invoice.payment_failed", {
        id: "in_failed", subscription: SUBSCRIPTION_ID,
        amount_due: 2999, currency: "usd",
      });

      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, planId: PLAN_ID,
        stripeSubscriptionId: SUBSCRIPTION_ID,
      });
      setupBillingEntityMock();
      setupPlanMock();

      await handler.handleInvoicePaymentFailed(event);

      expect(mockLedgerService.createEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: APP_ID, billToId: BILLING_ENTITY_ID,
          type: "ADJUSTMENT", amountMinor: 0,
          currency: "usd", referenceType: "STRIPE_INVOICE",
          referenceId: "in_failed",
          idempotencyKey: `invoice_failed:${event.id}`,
        }),
      );
    });

    it("skips invoices without a subscription", async () => {
      const event = makeStripeEvent("invoice.payment_failed", {
        id: "in_no_sub_fail", subscription: null,
        amount_due: 500, currency: "usd",
      });
      await handler.handleInvoicePaymentFailed(event);
      expect(mockPrisma.teamSubscription.findUnique).not.toHaveBeenCalled();
    });

    it("is idempotent — duplicate ledger entries silently ignored", async () => {
      const event = makeStripeEvent("invoice.payment_failed", {
        id: "in_fail_dup", subscription: SUBSCRIPTION_ID,
        amount_due: 2999, currency: "usd",
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, planId: PLAN_ID,
      });
      setupBillingEntityMock();
      setupPlanMock();
      mockLedgerService.createEntry.mockRejectedValue(
        new DuplicateLedgerEntryError("invoice_failed:test"),
      );
      await handler.handleInvoicePaymentFailed(event);
    });

    it("calls refreshEntitlements with teamId after payment failure", async () => {
      const event = makeStripeEvent("invoice.payment_failed", {
        id: "in_fail_ent", subscription: SUBSCRIPTION_ID,
        amount_due: 2999, currency: "usd",
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, planId: PLAN_ID,
        stripeSubscriptionId: SUBSCRIPTION_ID,
      });
      setupBillingEntityMock();
      setupPlanMock();

      await handler.handleInvoicePaymentFailed(event);

      expect(mockEntitlementService.refreshEntitlements).toHaveBeenCalledWith(TEAM_ID);
    });

    it("propagates non-duplicate ledger errors instead of swallowing them", async () => {
      const event = makeStripeEvent("invoice.payment_failed", {
        id: "in_fail_err", subscription: SUBSCRIPTION_ID,
        amount_due: 2999, currency: "usd",
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, planId: PLAN_ID,
      });
      setupBillingEntityMock();
      setupPlanMock();
      mockLedgerService.createEntry.mockRejectedValue(new Error("DB connection lost"));

      await expect(handler.handleInvoicePaymentFailed(event)).rejects.toThrow(
        "DB connection lost",
      );
    });
  });
});
