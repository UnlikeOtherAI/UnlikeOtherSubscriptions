import { getPrismaClient } from "../lib/prisma.js";
import { getStripeClient } from "../lib/stripe.js";
import { StripeService, TeamNotFoundError } from "./stripe.service.js";
import { LedgerService, DuplicateLedgerEntryError } from "./ledger.service.js";

export { TeamNotFoundError };

export interface TopupCheckoutInput {
  appId: string;
  teamId: string;
  amountMinor: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface TopupCheckoutResult {
  url: string;
  sessionId: string;
}

export class TopupService {
  private stripeService: StripeService;
  private ledgerService: LedgerService;

  constructor(stripeService?: StripeService, ledgerService?: LedgerService) {
    this.stripeService = stripeService ?? new StripeService();
    this.ledgerService = ledgerService ?? new LedgerService();
  }

  /**
   * Create a Stripe Checkout Session in payment mode for a one-time wallet top-up.
   */
  async createTopupCheckout(
    input: TopupCheckoutInput,
  ): Promise<TopupCheckoutResult> {
    const stripeCustomerId = await this.stripeService.getOrCreateStripeCustomer(
      input.teamId,
      input.appId,
    );

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: stripeCustomerId,
      line_items: [
        {
          price_data: {
            currency: input.currency,
            unit_amount: input.amountMinor,
            product_data: {
              name: "Wallet Top-Up",
            },
          },
          quantity: 1,
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: {
        teamId: input.teamId,
        appId: input.appId,
        type: "wallet_topup",
        amountMinor: String(input.amountMinor),
      },
      payment_intent_data: {
        metadata: {
          teamId: input.teamId,
          appId: input.appId,
          type: "wallet_topup",
          amountMinor: String(input.amountMinor),
        },
      },
    });

    return {
      url: session.url!,
      sessionId: session.id,
    };
  }

  /**
   * Handle a successful payment intent by crediting the team's wallet.
   * Called from the webhook handler on payment_intent.succeeded.
   */
  async handlePaymentIntentSucceeded(
    eventId: string,
    paymentIntentId: string,
    amountMinor: number,
    currency: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    const { teamId, appId } = metadata;

    if (!teamId || !appId || metadata.type !== "wallet_topup") {
      return;
    }

    const prisma = getPrismaClient();
    const billingEntity = await prisma.billingEntity.findUnique({
      where: { teamId },
    });

    if (!billingEntity) {
      return;
    }

    try {
      await this.ledgerService.createEntry({
        appId,
        billToId: billingEntity.id,
        accountType: "WALLET",
        type: "TOPUP",
        amountMinor,
        currency,
        referenceType: "STRIPE_PAYMENT_INTENT",
        referenceId: paymentIntentId,
        idempotencyKey: `topup:${eventId}`,
        metadata: {
          paymentIntentId,
          type: "wallet_topup",
        },
      });
    } catch (err: unknown) {
      if (!(err instanceof DuplicateLedgerEntryError)) {
        throw err;
      }
    }
  }

  /**
   * Check if wallet balance is below the auto-top-up threshold and trigger
   * a top-up if needed. Called after usage debits.
   */
  async checkAndTriggerAutoTopUp(
    appId: string,
    teamId: string,
  ): Promise<boolean> {
    const prisma = getPrismaClient();

    const walletConfig = await prisma.walletConfig.findUnique({
      where: { teamId_appId: { teamId, appId } },
    });

    if (!walletConfig || !walletConfig.autoTopUpEnabled) {
      return false;
    }

    const billingEntity = await prisma.billingEntity.findUnique({
      where: { teamId },
    });

    if (!billingEntity) {
      return false;
    }

    const balance = await this.ledgerService.getBalance(
      appId,
      billingEntity.id,
      "WALLET",
    );

    if (balance >= walletConfig.thresholdMinor) {
      return false;
    }

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team?.stripeCustomerId) {
      return false;
    }

    const stripe = getStripeClient();
    await stripe.paymentIntents.create({
      amount: walletConfig.topUpAmountMinor,
      currency: walletConfig.currency,
      customer: team.stripeCustomerId,
      confirm: true,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
      metadata: {
        teamId,
        appId,
        type: "wallet_topup",
        trigger: "auto_topup",
      },
    });

    return true;
  }
}
