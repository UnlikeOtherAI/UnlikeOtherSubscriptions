import Stripe from "stripe";
import { getPrismaClient } from "../lib/prisma.js";
import { getStripeClient } from "../lib/stripe.js";

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export class DuplicateWebhookEventError extends Error {
  constructor(eventId: string) {
    super(`Duplicate webhook event: ${eventId}`);
    this.name = "DuplicateWebhookEventError";
  }
}

const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "payment_intent.succeeded",
  "payment_intent.failed",
]);

export class WebhookService {
  /**
   * Verify the Stripe webhook signature and construct the event object.
   * Requires the raw request body (Buffer) — the body must NOT be JSON-parsed
   * before signature verification.
   */
  verifySignature(rawBody: Buffer, signature: string): Stripe.Event {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error("STRIPE_WEBHOOK_SECRET environment variable is not set");
    }

    const stripe = getStripeClient();
    try {
      return stripe.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Signature verification failed";
      throw new WebhookSignatureError(message);
    }
  }

  /**
   * Check if the event has already been processed (deduplication).
   * If not, record it. Returns true if the event is a duplicate.
   */
  async checkAndRecordEvent(
    eventId: string,
    eventType: string,
  ): Promise<boolean> {
    const prisma = getPrismaClient();

    try {
      await prisma.stripeWebhookEvent.create({
        data: { eventId, eventType },
      });
      return false; // Not a duplicate
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        return true; // Duplicate — unique constraint violation on eventId
      }
      throw err;
    }
  }

  /**
   * Route a verified Stripe event to the appropriate domain handler.
   * Returns true if the event type is handled, false if it's acknowledged
   * but not processed (unsupported event type).
   */
  routeEvent(event: Stripe.Event): boolean {
    return HANDLED_EVENT_TYPES.has(event.type);
  }
}
