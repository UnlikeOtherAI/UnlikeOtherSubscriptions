import Stripe from "stripe";
import { getPrismaClient } from "../lib/prisma.js";
import { TeamSubscriptionStatus } from "@prisma/client";
import { LedgerService, DuplicateLedgerEntryError } from "./ledger.service.js";
import { EntitlementService } from "./entitlement.service.js";

/**
 * Maps Stripe subscription status strings to our internal TeamSubscriptionStatus enum.
 */
function mapStripeStatus(stripeStatus: string): TeamSubscriptionStatus {
  switch (stripeStatus) {
    case "active":
      return "ACTIVE";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    case "incomplete":
      return "INCOMPLETE";
    case "trialing":
      return "TRIALING";
    case "unpaid":
      return "UNPAID";
    default:
      return "ACTIVE";
  }
}

export class SubscriptionHandlerService {
  private ledgerService: LedgerService;
  private entitlementService: EntitlementService;

  constructor(
    ledgerService?: LedgerService,
    entitlementService?: EntitlementService,
  ) {
    this.ledgerService = ledgerService ?? new LedgerService();
    this.entitlementService = entitlementService ?? new EntitlementService();
  }

  /**
   * Handle checkout.session.completed: create or update TeamSubscription,
   * write a ledger entry for the subscription charge.
   */
  async handleCheckoutSessionCompleted(
    event: Stripe.Event,
  ): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session;

    if (session.mode !== "subscription" || !session.subscription) {
      return;
    }

    const teamId = session.metadata?.teamId;
    const appId = session.metadata?.appId;
    const planId = session.metadata?.planId;

    if (!teamId || !appId || !planId) {
      return;
    }

    const prisma = getPrismaClient();
    const stripeSubscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription.id;

    // Resolve subscription details from Stripe object if available
    const subscription =
      typeof session.subscription === "object"
        ? session.subscription
        : null;

    const status = subscription
      ? mapStripeStatus(subscription.status)
      : "ACTIVE" as TeamSubscriptionStatus;

    const periodStart = subscription
      ? new Date(subscription.current_period_start * 1000)
      : new Date();
    const periodEnd = subscription
      ? new Date(subscription.current_period_end * 1000)
      : new Date();

    const seatsQuantity = this.extractSeatsQuantity(subscription);

    // Upsert the TeamSubscription (idempotent on stripeSubscriptionId)
    await prisma.teamSubscription.upsert({
      where: { stripeSubscriptionId },
      create: {
        teamId,
        stripeSubscriptionId,
        status,
        planId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        seatsQuantity,
      },
      update: {
        status,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        seatsQuantity,
      },
    });

    // Write a ledger entry for the initial subscription charge
    const billingEntity = await prisma.billingEntity.findUnique({
      where: { teamId },
    });

    if (billingEntity && session.amount_total) {
      try {
        await this.ledgerService.createEntry({
          appId,
          billToId: billingEntity.id,
          accountType: "REVENUE",
          type: "SUBSCRIPTION_CHARGE",
          amountMinor: session.amount_total,
          currency: session.currency ?? "usd",
          referenceType: "STRIPE_PAYMENT_INTENT",
          referenceId: typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id,
          idempotencyKey: `checkout:${event.id}`,
          metadata: {
            stripeSubscriptionId,
            planId,
            sessionId: session.id,
          },
        });
      } catch (err: unknown) {
        if (!(err instanceof DuplicateLedgerEntryError)) {
          throw err;
        }
      }
    }

    await this.entitlementService.refreshEntitlements(teamId);
  }

  /**
   * Handle customer.subscription.updated: update TeamSubscription status and period dates.
   */
  async handleSubscriptionUpdated(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;
    const prisma = getPrismaClient();

    const existing = await prisma.teamSubscription.findUnique({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!existing) {
      return;
    }

    await prisma.teamSubscription.update({
      where: { stripeSubscriptionId: subscription.id },
      data: {
        status: mapStripeStatus(subscription.status),
        currentPeriodStart: new Date(
          subscription.current_period_start * 1000,
        ),
        currentPeriodEnd: new Date(
          subscription.current_period_end * 1000,
        ),
        seatsQuantity: this.extractSeatsQuantity(subscription),
      },
    });

    await this.entitlementService.refreshEntitlements(existing.teamId);
  }

  /**
   * Handle customer.subscription.deleted: mark TeamSubscription as cancelled.
   */
  async handleSubscriptionDeleted(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;
    const prisma = getPrismaClient();

    const existing = await prisma.teamSubscription.findUnique({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!existing) {
      return;
    }

    await prisma.teamSubscription.update({
      where: { stripeSubscriptionId: subscription.id },
      data: { status: "CANCELED" },
    });

    await this.entitlementService.refreshEntitlements(existing.teamId);
  }

  /**
   * Handle invoice.paid: write a SUBSCRIPTION_CHARGE ledger entry.
   */
  async handleInvoicePaid(event: Stripe.Event): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;

    if (!invoice.subscription) {
      return;
    }

    const stripeSubscriptionId =
      typeof invoice.subscription === "string"
        ? invoice.subscription
        : invoice.subscription.id;

    const prisma = getPrismaClient();

    const teamSub = await prisma.teamSubscription.findUnique({
      where: { stripeSubscriptionId },
    });

    if (!teamSub) {
      return;
    }

    const billingEntity = await prisma.billingEntity.findUnique({
      where: { teamId: teamSub.teamId },
    });

    if (!billingEntity || !invoice.amount_paid) {
      return;
    }

    // Resolve appId from the plan
    const plan = await prisma.plan.findUnique({
      where: { id: teamSub.planId },
    });

    if (!plan) {
      return;
    }

    try {
      await this.ledgerService.createEntry({
        appId: plan.appId,
        billToId: billingEntity.id,
        accountType: "REVENUE",
        type: "SUBSCRIPTION_CHARGE",
        amountMinor: invoice.amount_paid,
        currency: invoice.currency ?? "usd",
        referenceType: "STRIPE_INVOICE",
        referenceId: invoice.id,
        idempotencyKey: `invoice_paid:${event.id}`,
        metadata: {
          stripeSubscriptionId,
          invoiceId: invoice.id,
        },
      });
    } catch (err: unknown) {
      if (!(err instanceof DuplicateLedgerEntryError)) {
        throw err;
      }
    }
  }

  /**
   * Handle invoice.payment_failed: write an ADJUSTMENT ledger entry,
   * optionally flag the team for grace period.
   */
  async handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;

    if (!invoice.subscription) {
      return;
    }

    const stripeSubscriptionId =
      typeof invoice.subscription === "string"
        ? invoice.subscription
        : invoice.subscription.id;

    const prisma = getPrismaClient();

    const teamSub = await prisma.teamSubscription.findUnique({
      where: { stripeSubscriptionId },
    });

    if (!teamSub) {
      return;
    }

    const billingEntity = await prisma.billingEntity.findUnique({
      where: { teamId: teamSub.teamId },
    });

    if (!billingEntity) {
      return;
    }

    const plan = await prisma.plan.findUnique({
      where: { id: teamSub.planId },
    });

    if (!plan) {
      return;
    }

    try {
      await this.ledgerService.createEntry({
        appId: plan.appId,
        billToId: billingEntity.id,
        accountType: "REVENUE",
        type: "ADJUSTMENT",
        amountMinor: 0,
        currency: invoice.currency ?? "usd",
        referenceType: "STRIPE_INVOICE",
        referenceId: invoice.id,
        idempotencyKey: `invoice_failed:${event.id}`,
        metadata: {
          stripeSubscriptionId,
          invoiceId: invoice.id,
          reason: "payment_failed",
          amountDue: invoice.amount_due,
        },
      });
    } catch (err: unknown) {
      if (!(err instanceof DuplicateLedgerEntryError)) {
        throw err;
      }
    }

    await this.entitlementService.refreshEntitlements(teamSub.teamId);
  }

  /**
   * Extract total seats quantity from Stripe subscription items.
   */
  private extractSeatsQuantity(
    subscription: Stripe.Subscription | null,
  ): number {
    if (!subscription?.items?.data) {
      return 1;
    }
    let totalQuantity = 0;
    for (const item of subscription.items.data) {
      totalQuantity += item.quantity ?? 0;
    }
    return totalQuantity || 1;
  }
}
