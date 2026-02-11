import { getPrismaClient } from "../lib/prisma.js";
import { getStripeClient } from "../lib/stripe.js";
import { StripeService, TeamNotFoundError } from "./stripe.service.js";

export class PlanNotFoundError extends Error {
  constructor(appId: string, planCode: string) {
    super(`Plan not found: appId=${appId}, planCode=${planCode}`);
    this.name = "PlanNotFoundError";
  }
}

export { TeamNotFoundError };

export interface CheckoutSubscriptionInput {
  appId: string;
  teamId: string;
  planCode: string;
  successUrl: string;
  cancelUrl: string;
  seats?: number;
}

export interface CheckoutSubscriptionResult {
  url: string;
  sessionId: string;
}

export class CheckoutService {
  private stripeService: StripeService;

  constructor(stripeService?: StripeService) {
    this.stripeService = stripeService ?? new StripeService();
  }

  async createSubscriptionCheckout(
    input: CheckoutSubscriptionInput,
  ): Promise<CheckoutSubscriptionResult> {
    const prisma = getPrismaClient();

    // Look up the Plan and verify it belongs to the requesting App
    const plan = await prisma.plan.findUnique({
      where: {
        appId_code: {
          appId: input.appId,
          code: input.planCode,
        },
      },
      include: {
        stripeProductMaps: true,
      },
    });

    if (!plan) {
      throw new PlanNotFoundError(input.appId, input.planCode);
    }

    // Get or create a Stripe customer for the team
    const stripeCustomerId = await this.stripeService.getOrCreateStripeCustomer(
      input.teamId,
      input.appId,
    );

    // Build Stripe Checkout line items from StripeProductMap entries
    const lineItems = this.buildLineItems(plan.stripeProductMaps, input.seats);

    // Create the Stripe Checkout Session
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: lineItems,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: {
        teamId: input.teamId,
        appId: input.appId,
        planId: plan.id,
      },
    });

    return {
      url: session.url!,
      sessionId: session.id,
    };
  }

  private buildLineItems(
    productMaps: Array<{
      stripePriceId: string;
      kind: string;
    }>,
    seats?: number,
  ): Array<{ price: string; quantity: number }> {
    const lineItems: Array<{ price: string; quantity: number }> = [];

    for (const map of productMaps) {
      if (map.kind === "BASE") {
        lineItems.push({ price: map.stripePriceId, quantity: 1 });
      } else if (map.kind === "SEAT") {
        lineItems.push({
          price: map.stripePriceId,
          quantity: seats ?? 1,
        });
      }
    }

    return lineItems;
  }
}
