import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { v4 as uuidv4 } from "uuid";

const TEST_APP_ID = uuidv4();
const TEST_TEAM_ID = uuidv4();
const TEST_BILL_TO_ID = uuidv4();

const mockPaymentIntentsCreate = vi.fn();
const mockCheckoutSessionCreate = vi.fn();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    billingEntity: { findUnique: vi.fn() },
    team: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    walletConfig: { findUnique: vi.fn() },
    ledgerAccount: { findUnique: vi.fn(), create: vi.fn() },
    ledgerEntry: { create: vi.fn(), aggregate: vi.fn() },
    $transaction: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/stripe.js", () => ({
  getStripeClient: () => ({
    paymentIntents: { create: mockPaymentIntentsCreate },
    checkout: { sessions: { create: mockCheckoutSessionCreate } },
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_test" }) },
  }),
  resetStripeClient: vi.fn(),
}));

import { TopupService } from "./topup.service.js";
import { LedgerService, DuplicateLedgerEntryError } from "./ledger.service.js";

describe("TopupService", () => {
  let topupService: TopupService;
  let mockLedgerService: {
    createEntry: ReturnType<typeof vi.fn>;
    getBalance: ReturnType<typeof vi.fn>;
    getOrCreateAccount: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockLedgerService = {
      createEntry: vi.fn().mockResolvedValue("entry-id"),
      getBalance: vi.fn().mockResolvedValue(0),
      getOrCreateAccount: vi.fn().mockResolvedValue("account-id"),
    };

    topupService = new TopupService(
      undefined,
      mockLedgerService as unknown as LedgerService,
    );
  });

  describe("handlePaymentIntentSucceeded", () => {
    it("creates a TOPUP ledger entry with correct amount", async () => {
      mockPrisma.billingEntity.findUnique.mockResolvedValue({
        id: TEST_BILL_TO_ID,
        type: "TEAM",
        teamId: TEST_TEAM_ID,
      });

      await topupService.handlePaymentIntentSucceeded(
        "evt_test_123",
        "pi_test_456",
        5000,
        "usd",
        {
          teamId: TEST_TEAM_ID,
          appId: TEST_APP_ID,
          type: "wallet_topup",
        },
      );

      expect(mockLedgerService.createEntry).toHaveBeenCalledWith({
        appId: TEST_APP_ID,
        billToId: TEST_BILL_TO_ID,
        accountType: "WALLET",
        type: "TOPUP",
        amountMinor: 5000,
        currency: "usd",
        referenceType: "STRIPE_PAYMENT_INTENT",
        referenceId: "pi_test_456",
        idempotencyKey: "topup:evt_test_123",
        metadata: {
          paymentIntentId: "pi_test_456",
          type: "wallet_topup",
        },
      });
    });

    it("skips non-wallet_topup payment intents", async () => {
      await topupService.handlePaymentIntentSucceeded(
        "evt_test_123",
        "pi_test_456",
        5000,
        "usd",
        { teamId: TEST_TEAM_ID, appId: TEST_APP_ID, type: "other" },
      );

      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("skips payment intents without metadata", async () => {
      await topupService.handlePaymentIntentSucceeded(
        "evt_test_123",
        "pi_test_456",
        5000,
        "usd",
        {},
      );

      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });

    it("handles duplicate payment intents idempotently", async () => {
      mockPrisma.billingEntity.findUnique.mockResolvedValue({
        id: TEST_BILL_TO_ID,
        type: "TEAM",
        teamId: TEST_TEAM_ID,
      });

      mockLedgerService.createEntry.mockRejectedValue(
        new DuplicateLedgerEntryError("topup:evt_test_123"),
      );

      await topupService.handlePaymentIntentSucceeded(
        "evt_test_123",
        "pi_test_456",
        5000,
        "usd",
        {
          teamId: TEST_TEAM_ID,
          appId: TEST_APP_ID,
          type: "wallet_topup",
        },
      );
    });

    it("skips when billing entity not found", async () => {
      mockPrisma.billingEntity.findUnique.mockResolvedValue(null);

      await topupService.handlePaymentIntentSucceeded(
        "evt_test_123",
        "pi_test_456",
        5000,
        "usd",
        {
          teamId: TEST_TEAM_ID,
          appId: TEST_APP_ID,
          type: "wallet_topup",
        },
      );

      expect(mockLedgerService.createEntry).not.toHaveBeenCalled();
    });
  });

  describe("checkAndTriggerAutoTopUp", () => {
    it("triggers auto-top-up when balance is below threshold", async () => {
      mockPrisma.walletConfig.findUnique.mockResolvedValue({
        id: uuidv4(),
        teamId: TEST_TEAM_ID,
        appId: TEST_APP_ID,
        autoTopUpEnabled: true,
        thresholdMinor: 1000,
        topUpAmountMinor: 5000,
        currency: "usd",
      });

      mockPrisma.billingEntity.findUnique.mockResolvedValue({
        id: TEST_BILL_TO_ID,
        type: "TEAM",
        teamId: TEST_TEAM_ID,
      });

      mockLedgerService.getBalance.mockResolvedValue(500);

      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        stripeCustomerId: "cus_test_123",
      });

      mockPaymentIntentsCreate.mockResolvedValue({
        id: "pi_auto_topup",
        status: "succeeded",
      });

      const triggered = await topupService.checkAndTriggerAutoTopUp(
        TEST_APP_ID,
        TEST_TEAM_ID,
      );

      expect(triggered).toBe(true);
      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith({
        amount: 5000,
        currency: "usd",
        customer: "cus_test_123",
        confirm: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: "never",
        },
        metadata: {
          teamId: TEST_TEAM_ID,
          appId: TEST_APP_ID,
          type: "wallet_topup",
          trigger: "auto_topup",
        },
      });
    });

    it("does not trigger when balance is above threshold", async () => {
      mockPrisma.walletConfig.findUnique.mockResolvedValue({
        id: uuidv4(),
        teamId: TEST_TEAM_ID,
        appId: TEST_APP_ID,
        autoTopUpEnabled: true,
        thresholdMinor: 1000,
        topUpAmountMinor: 5000,
        currency: "usd",
      });

      mockPrisma.billingEntity.findUnique.mockResolvedValue({
        id: TEST_BILL_TO_ID,
        type: "TEAM",
        teamId: TEST_TEAM_ID,
      });

      mockLedgerService.getBalance.mockResolvedValue(2000);

      const triggered = await topupService.checkAndTriggerAutoTopUp(
        TEST_APP_ID,
        TEST_TEAM_ID,
      );

      expect(triggered).toBe(false);
      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    });

    it("does not trigger when auto-top-up is disabled", async () => {
      mockPrisma.walletConfig.findUnique.mockResolvedValue({
        id: uuidv4(),
        teamId: TEST_TEAM_ID,
        appId: TEST_APP_ID,
        autoTopUpEnabled: false,
        thresholdMinor: 1000,
        topUpAmountMinor: 5000,
        currency: "usd",
      });

      const triggered = await topupService.checkAndTriggerAutoTopUp(
        TEST_APP_ID,
        TEST_TEAM_ID,
      );

      expect(triggered).toBe(false);
      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    });

    it("does not trigger when no wallet config exists", async () => {
      mockPrisma.walletConfig.findUnique.mockResolvedValue(null);

      const triggered = await topupService.checkAndTriggerAutoTopUp(
        TEST_APP_ID,
        TEST_TEAM_ID,
      );

      expect(triggered).toBe(false);
      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    });

    it("does not trigger when team has no Stripe customer", async () => {
      mockPrisma.walletConfig.findUnique.mockResolvedValue({
        id: uuidv4(),
        teamId: TEST_TEAM_ID,
        appId: TEST_APP_ID,
        autoTopUpEnabled: true,
        thresholdMinor: 1000,
        topUpAmountMinor: 5000,
        currency: "usd",
      });

      mockPrisma.billingEntity.findUnique.mockResolvedValue({
        id: TEST_BILL_TO_ID,
        type: "TEAM",
        teamId: TEST_TEAM_ID,
      });

      mockLedgerService.getBalance.mockResolvedValue(500);

      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        stripeCustomerId: null,
      });

      const triggered = await topupService.checkAndTriggerAutoTopUp(
        TEST_APP_ID,
        TEST_TEAM_ID,
      );

      expect(triggered).toBe(false);
      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    });

    it("does not trigger when balance equals threshold exactly", async () => {
      mockPrisma.walletConfig.findUnique.mockResolvedValue({
        id: uuidv4(),
        teamId: TEST_TEAM_ID,
        appId: TEST_APP_ID,
        autoTopUpEnabled: true,
        thresholdMinor: 1000,
        topUpAmountMinor: 5000,
        currency: "usd",
      });

      mockPrisma.billingEntity.findUnique.mockResolvedValue({
        id: TEST_BILL_TO_ID,
        type: "TEAM",
        teamId: TEST_TEAM_ID,
      });

      mockLedgerService.getBalance.mockResolvedValue(1000);

      const triggered = await topupService.checkAndTriggerAutoTopUp(
        TEST_APP_ID,
        TEST_TEAM_ID,
      );

      expect(triggered).toBe(false);
      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    });
  });

  describe("checkout → payment_intent.succeeded → TOPUP ledger entry (regression)", () => {
    it("checkout sets payment_intent_data.metadata and payment_intent.succeeded creates TOPUP entry", async () => {
      // Step 1: Simulate team existing with a stripe customer
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEST_TEAM_ID,
        name: "Test Team",
        stripeCustomerId: "cus_test_existing",
      });

      const capturedMetadata: Record<string, string> = {
        teamId: TEST_TEAM_ID,
        appId: TEST_APP_ID,
        type: "wallet_topup",
        amountMinor: "5000",
      };

      mockCheckoutSessionCreate.mockResolvedValue({
        id: "cs_test_regression",
        url: "https://checkout.stripe.com/c/pay/cs_test_regression",
      });

      // Step 1: Create checkout — verify payment_intent_data.metadata is set
      const stripeService = new (await import("./stripe.service.js")).StripeService();
      const topupWithStripe = new TopupService(stripeService, mockLedgerService as unknown as LedgerService);

      const result = await topupWithStripe.createTopupCheckout({
        appId: TEST_APP_ID,
        teamId: TEST_TEAM_ID,
        amountMinor: 5000,
        currency: "usd",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

      expect(result.sessionId).toBe("cs_test_regression");

      const checkoutArgs = mockCheckoutSessionCreate.mock.calls[0][0];
      expect(checkoutArgs.payment_intent_data).toBeDefined();
      expect(checkoutArgs.payment_intent_data.metadata).toEqual(capturedMetadata);

      // Step 2: Simulate payment_intent.succeeded with the same metadata
      // (Stripe propagates payment_intent_data.metadata to the PaymentIntent)
      mockPrisma.billingEntity.findUnique.mockResolvedValue({
        id: TEST_BILL_TO_ID,
        type: "TEAM",
        teamId: TEST_TEAM_ID,
      });

      await topupService.handlePaymentIntentSucceeded(
        "evt_regression_test",
        "pi_regression_test",
        5000,
        "usd",
        capturedMetadata,
      );

      // Step 3: Verify TOPUP ledger entry was created
      expect(mockLedgerService.createEntry).toHaveBeenCalledWith({
        appId: TEST_APP_ID,
        billToId: TEST_BILL_TO_ID,
        accountType: "WALLET",
        type: "TOPUP",
        amountMinor: 5000,
        currency: "usd",
        referenceType: "STRIPE_PAYMENT_INTENT",
        referenceId: "pi_regression_test",
        idempotencyKey: "topup:evt_regression_test",
        metadata: {
          paymentIntentId: "pi_regression_test",
          type: "wallet_topup",
        },
      });
    });
  });
});
