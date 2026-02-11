import { Prisma } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";
import { getStripeClient } from "../lib/stripe.js";

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}

export class StripeService {
  /**
   * Lazily creates a Stripe Customer for a Team. If the Team already has a
   * stripeCustomerId, returns it immediately. Otherwise creates a new Stripe
   * Customer, stores the ID on the Team, and returns it.
   *
   * Race-condition safe: uses a compare-and-swap pattern — only updates the
   * Team row if stripeCustomerId is still null. If a concurrent call already
   * set it, we use the existing value and avoid creating a duplicate.
   */
  async getOrCreateStripeCustomer(
    teamId: string,
    appId: string,
  ): Promise<string> {
    const prisma = getPrismaClient();

    // 1. Check if the Team already has a Stripe customer
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new TeamNotFoundError(teamId);
    }

    if (team.stripeCustomerId) {
      return team.stripeCustomerId;
    }

    // 2. Create a Stripe Customer
    const stripe = getStripeClient();
    const customer = await stripe.customers.create({
      name: team.name,
      metadata: {
        teamId,
        appId,
      },
    });

    // 3. Compare-and-swap: only update if stripeCustomerId is still null
    try {
      const updated = await prisma.team.updateMany({
        where: {
          id: teamId,
          stripeCustomerId: null,
        },
        data: {
          stripeCustomerId: customer.id,
        },
      });

      if (updated.count > 0) {
        // We won the race — our customer ID is now stored
        return customer.id;
      }
    } catch (err) {
      // If P2002 unique constraint violation (shouldn't happen with updateMany + where, but defensive)
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Fall through to re-read
      } else {
        throw err;
      }
    }

    // 4. Another caller won the race — read the stored customer ID
    const reFetched = await prisma.team.findUnique({ where: { id: teamId } });
    return reFetched!.stripeCustomerId!;
  }
}
