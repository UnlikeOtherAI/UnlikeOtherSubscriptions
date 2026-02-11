import { getPrismaClient } from "../lib/prisma.js";
import { getStripeClient } from "../lib/stripe.js";

const CLAIM_PREFIX = "pending:";

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}

export class StripeService {
  /**
   * Lazily creates a Stripe Customer for a Team. If the Team already has a
   * stripeCustomerId, returns it immediately. Otherwise atomically claims the
   * right to create a customer, calls Stripe, and stores the real ID.
   *
   * Race-condition safe: uses an atomic claim (updateMany WHERE
   * stripeCustomerId IS NULL) *before* calling the Stripe API, ensuring
   * only one caller ever creates a Stripe customer for a given Team.
   */
  async getOrCreateStripeCustomer(
    teamId: string,
    appId?: string,
  ): Promise<string> {
    const prisma = getPrismaClient();

    // 1. Check if the Team already has a Stripe customer (or a pending claim)
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new TeamNotFoundError(teamId);
    }

    if (team.stripeCustomerId && !team.stripeCustomerId.startsWith(CLAIM_PREFIX)) {
      return team.stripeCustomerId;
    }

    // If another call has a pending claim, wait and re-read
    if (team.stripeCustomerId?.startsWith(CLAIM_PREFIX)) {
      return this.waitForCustomerId(teamId);
    }

    // 2. Atomically claim the right to create the Stripe customer
    const claimToken = `${CLAIM_PREFIX}${teamId}`;
    const claimed = await prisma.team.updateMany({
      where: {
        id: teamId,
        stripeCustomerId: null,
      },
      data: {
        stripeCustomerId: claimToken,
      },
    });

    if (claimed.count === 0) {
      // Another caller claimed it first — wait for the real ID
      return this.waitForCustomerId(teamId);
    }

    // 3. We won the claim — create the Stripe Customer
    try {
      const stripe = getStripeClient();
      const metadata: Record<string, string> = { teamId };
      if (appId) {
        metadata.appId = appId;
      }

      const customer = await stripe.customers.create({
        name: team.name,
        metadata,
      });

      // 4. Replace the claim token with the real customer ID
      await prisma.team.update({
        where: { id: teamId },
        data: { stripeCustomerId: customer.id },
      });

      return customer.id;
    } catch (err) {
      // Roll back the claim so other callers can retry
      await prisma.team.updateMany({
        where: { id: teamId, stripeCustomerId: claimToken },
        data: { stripeCustomerId: null },
      });
      throw err;
    }
  }

  /**
   * Polls until the team's stripeCustomerId is set to a real (non-pending) value.
   */
  private async waitForCustomerId(teamId: string): Promise<string> {
    const prisma = getPrismaClient();
    const maxAttempts = 50;
    const delayMs = 100;

    for (let i = 0; i < maxAttempts; i++) {
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!team) {
        throw new TeamNotFoundError(teamId);
      }
      if (team.stripeCustomerId && !team.stripeCustomerId.startsWith(CLAIM_PREFIX)) {
        return team.stripeCustomerId;
      }
      if (!team.stripeCustomerId) {
        // Claim was rolled back (error case) — retry the whole flow
        return this.getOrCreateStripeCustomer(teamId);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(`Timed out waiting for Stripe customer creation for team: ${teamId}`);
  }
}
