import { Prisma } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";

export const MAX_BATCH_SIZE = 1000;

export interface UsageEventInput {
  idempotencyKey: string;
  eventType: string;
  timestamp: string;
  payload: Record<string, unknown>;
  source: string;
  teamId?: string;
  userId?: string;
}

export interface IngestUsageEventsInput {
  appId: string;
  events: UsageEventInput[];
}

export interface IngestUsageEventsResult {
  accepted: number;
  duplicates: number;
}

export class UsageEventService {
  async ingestEvents(input: IngestUsageEventsInput): Promise<IngestUsageEventsResult> {
    const prisma = getPrismaClient();

    // Validate App exists
    const app = await prisma.app.findUnique({ where: { id: input.appId } });
    if (!app) {
      throw new AppNotFoundError(input.appId);
    }

    if (input.events.length > MAX_BATCH_SIZE) {
      throw new BatchTooLargeError(input.events.length, MAX_BATCH_SIZE);
    }

    let accepted = 0;
    let duplicates = 0;

    for (const event of input.events) {
      const teamId = await this.resolveTeamId(prisma, input.appId, event);
      const billToId = await this.resolveBillToId(prisma, teamId);

      try {
        await prisma.usageEvent.create({
          data: {
            appId: input.appId,
            teamId,
            billToId,
            userId: event.userId ?? null,
            eventType: event.eventType,
            timestamp: new Date(event.timestamp),
            idempotencyKey: event.idempotencyKey,
            payload: event.payload as Prisma.InputJsonValue,
            source: event.source,
          },
        });
        accepted++;
      } catch (err) {
        // P2002: unique constraint violation on (appId, idempotencyKey) — duplicate
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          duplicates++;
        } else {
          throw err;
        }
      }
    }

    return { accepted, duplicates };
  }

  private async resolveTeamId(
    prisma: ReturnType<typeof getPrismaClient>,
    appId: string,
    event: UsageEventInput,
  ): Promise<string> {
    if (event.teamId) {
      return event.teamId;
    }

    if (!event.userId) {
      throw new MissingTeamAndUserError();
    }

    // Resolve from user's Personal Team
    const user = await prisma.user.findUnique({
      where: {
        appId_externalRef: { appId, externalRef: event.userId },
      },
    });

    if (!user) {
      // Try by user ID directly
      const userById = await prisma.user.findUnique({
        where: { id: event.userId },
      });
      if (!userById) {
        throw new UserNotFoundError(event.userId);
      }

      const personalTeam = await prisma.team.findFirst({
        where: { kind: "PERSONAL", ownerUserId: userById.id },
      });
      if (!personalTeam) {
        throw new PersonalTeamNotFoundError(event.userId);
      }
      return personalTeam.id;
    }

    const personalTeam = await prisma.team.findFirst({
      where: { kind: "PERSONAL", ownerUserId: user.id },
    });
    if (!personalTeam) {
      throw new PersonalTeamNotFoundError(event.userId);
    }
    return personalTeam.id;
  }

  private async resolveBillToId(
    prisma: ReturnType<typeof getPrismaClient>,
    teamId: string,
  ): Promise<string> {
    const billingEntity = await prisma.billingEntity.findUnique({
      where: { teamId },
    });
    if (!billingEntity) {
      throw new BillingEntityNotFoundError(teamId);
    }
    return billingEntity.id;
  }
}

export class AppNotFoundError extends Error {
  constructor(appId: string) {
    super(`App not found: ${appId}`);
    this.name = "AppNotFoundError";
  }
}

export class BatchTooLargeError extends Error {
  constructor(actual: number, max: number) {
    super(`Batch size ${actual} exceeds maximum of ${max}`);
    this.name = "BatchTooLargeError";
  }
}

export class MissingTeamAndUserError extends Error {
  constructor() {
    super("Either teamId or userId must be provided for each event");
    this.name = "MissingTeamAndUserError";
  }
}

export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.name = "UserNotFoundError";
  }
}

export class PersonalTeamNotFoundError extends Error {
  constructor(userId: string) {
    super(`Personal team not found for user: ${userId}`);
    this.name = "PersonalTeamNotFoundError";
  }
}

export class BillingEntityNotFoundError extends Error {
  constructor(teamId: string) {
    super(`BillingEntity not found for team: ${teamId}`);
    this.name = "BillingEntityNotFoundError";
  }
}
