import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";
import { SubscriptionHandlerService } from "./subscription-handler.service.js";

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

function setupLedgerAccountMock() {
  mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
    id: "la-001", appId: APP_ID, billToId: BILLING_ENTITY_ID, type: "REVENUE",
  });
}

function setupLedgerEntryMock() {
  mockPrisma.ledgerEntry.create.mockResolvedValue({
    id: "le-001", idempotencyKey: "test-key",
  });
}

// --- Tests ---

describe("SubscriptionHandlerService — checkout & subscription events", () => {
  let handler: SubscriptionHandlerService;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new SubscriptionHandlerService();
  });

  describe("handleCheckoutSessionCompleted", () => {
    it("creates TeamSubscription and ledger entry", async () => {
      const event = makeStripeEvent("checkout.session.completed", {
        id: "cs_test_123",
        mode: "subscription",
        subscription: SUBSCRIPTION_ID,
        metadata: { teamId: TEAM_ID, appId: APP_ID, planId: PLAN_ID },
        amount_total: 2999,
        currency: "usd",
        payment_intent: "pi_test_123",
      });

      mockPrisma.teamSubscription.upsert.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID,
        stripeSubscriptionId: SUBSCRIPTION_ID, status: "ACTIVE", planId: PLAN_ID,
      });
      setupBillingEntityMock();
      setupLedgerAccountMock();
      setupLedgerEntryMock();

      await handler.handleCheckoutSessionCompleted(event);

      expect(mockPrisma.teamSubscription.upsert).toHaveBeenCalledWith({
        where: { stripeSubscriptionId: SUBSCRIPTION_ID },
        create: expect.objectContaining({
          teamId: TEAM_ID, stripeSubscriptionId: SUBSCRIPTION_ID,
          status: "ACTIVE", planId: PLAN_ID,
        }),
        update: expect.objectContaining({ status: "ACTIVE" }),
      });

      expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          appId: APP_ID, billToId: BILLING_ENTITY_ID,
          type: "SUBSCRIPTION_CHARGE", amountMinor: 2999,
          currency: "usd", referenceType: "STRIPE_PAYMENT_INTENT",
          referenceId: "pi_test_123", idempotencyKey: `checkout:${event.id}`,
        }),
      });
    });

    it("skips non-subscription checkout sessions", async () => {
      const event = makeStripeEvent("checkout.session.completed", {
        id: "cs_payment", mode: "payment", subscription: null,
        metadata: { teamId: TEAM_ID },
      });
      await handler.handleCheckoutSessionCompleted(event);
      expect(mockPrisma.teamSubscription.upsert).not.toHaveBeenCalled();
    });

    it("skips when metadata is missing teamId", async () => {
      const event = makeStripeEvent("checkout.session.completed", {
        id: "cs_no_meta", mode: "subscription",
        subscription: SUBSCRIPTION_ID, metadata: {},
      });
      await handler.handleCheckoutSessionCompleted(event);
      expect(mockPrisma.teamSubscription.upsert).not.toHaveBeenCalled();
    });

    it("is idempotent — duplicate ledger entries silently ignored", async () => {
      const event = makeStripeEvent("checkout.session.completed", {
        id: "cs_idem", mode: "subscription",
        subscription: SUBSCRIPTION_ID,
        metadata: { teamId: TEAM_ID, appId: APP_ID, planId: PLAN_ID },
        amount_total: 1999, currency: "usd", payment_intent: "pi_dup",
      });
      mockPrisma.teamSubscription.upsert.mockResolvedValue({ id: "ts-001" });
      setupBillingEntityMock();
      setupLedgerAccountMock();
      mockPrisma.ledgerEntry.create.mockRejectedValue({
        code: "P2002", meta: { target: ["idempotencyKey"] },
      });
      await handler.handleCheckoutSessionCompleted(event);
      expect(mockPrisma.teamSubscription.upsert).toHaveBeenCalled();
    });

    it("handles embedded subscription object in session", async () => {
      const periodStart = Math.floor(Date.now() / 1000);
      const periodEnd = periodStart + 30 * 86400;
      const event = makeStripeEvent("checkout.session.completed", {
        id: "cs_embedded", mode: "subscription",
        subscription: {
          id: SUBSCRIPTION_ID, status: "trialing",
          current_period_start: periodStart,
          current_period_end: periodEnd,
          items: { data: [{ quantity: 5 }] },
        },
        metadata: { teamId: TEAM_ID, appId: APP_ID, planId: PLAN_ID },
        amount_total: 4999, currency: "usd", payment_intent: "pi_emb",
      });
      mockPrisma.teamSubscription.upsert.mockResolvedValue({ id: "ts-002" });
      setupBillingEntityMock();
      setupLedgerAccountMock();
      setupLedgerEntryMock();

      await handler.handleCheckoutSessionCompleted(event);

      expect(mockPrisma.teamSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "TRIALING", seatsQuantity: 5,
            currentPeriodStart: new Date(periodStart * 1000),
            currentPeriodEnd: new Date(periodEnd * 1000),
          }),
        }),
      );
    });
  });

  describe("handleSubscriptionUpdated", () => {
    it("updates TeamSubscription status and period dates", async () => {
      const periodStart = Math.floor(Date.now() / 1000);
      const periodEnd = periodStart + 30 * 86400;
      const event = makeStripeEvent("customer.subscription.updated", {
        id: SUBSCRIPTION_ID, status: "active",
        current_period_start: periodStart, current_period_end: periodEnd,
        items: { data: [{ quantity: 3 }] },
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, stripeSubscriptionId: SUBSCRIPTION_ID,
      });
      mockPrisma.teamSubscription.update.mockResolvedValue({ id: "ts-001" });

      await handler.handleSubscriptionUpdated(event);

      expect(mockPrisma.teamSubscription.update).toHaveBeenCalledWith({
        where: { stripeSubscriptionId: SUBSCRIPTION_ID },
        data: {
          status: "ACTIVE",
          currentPeriodStart: new Date(periodStart * 1000),
          currentPeriodEnd: new Date(periodEnd * 1000),
          seatsQuantity: 3,
        },
      });
    });

    it("skips if TeamSubscription does not exist", async () => {
      const event = makeStripeEvent("customer.subscription.updated", {
        id: "sub_unknown", status: "active",
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        items: { data: [] },
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue(null);
      await handler.handleSubscriptionUpdated(event);
      expect(mockPrisma.teamSubscription.update).not.toHaveBeenCalled();
    });

    it("maps past_due status correctly", async () => {
      const event = makeStripeEvent("customer.subscription.updated", {
        id: SUBSCRIPTION_ID, status: "past_due",
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        items: { data: [{ quantity: 1 }] },
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, stripeSubscriptionId: SUBSCRIPTION_ID,
      });
      mockPrisma.teamSubscription.update.mockResolvedValue({});
      await handler.handleSubscriptionUpdated(event);
      expect(mockPrisma.teamSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "PAST_DUE" }),
        }),
      );
    });
  });

  describe("handleSubscriptionDeleted", () => {
    it("marks TeamSubscription as cancelled", async () => {
      const event = makeStripeEvent("customer.subscription.deleted", {
        id: SUBSCRIPTION_ID, status: "canceled",
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000),
        items: { data: [] },
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue({
        id: "ts-001", teamId: TEAM_ID, stripeSubscriptionId: SUBSCRIPTION_ID,
      });
      mockPrisma.teamSubscription.update.mockResolvedValue({ status: "CANCELED" });

      await handler.handleSubscriptionDeleted(event);

      expect(mockPrisma.teamSubscription.update).toHaveBeenCalledWith({
        where: { stripeSubscriptionId: SUBSCRIPTION_ID },
        data: { status: "CANCELED" },
      });
    });

    it("skips if TeamSubscription does not exist", async () => {
      const event = makeStripeEvent("customer.subscription.deleted", {
        id: "sub_nonexistent", status: "canceled",
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000),
        items: { data: [] },
      });
      mockPrisma.teamSubscription.findUnique.mockResolvedValue(null);
      await handler.handleSubscriptionDeleted(event);
      expect(mockPrisma.teamSubscription.update).not.toHaveBeenCalled();
    });
  });
});
