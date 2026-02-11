import { Prisma } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";

export interface CreateTeamInput {
  appId: string;
  name: string;
  externalTeamId?: string;
}

export interface CreateTeamResult {
  team: {
    id: string;
    name: string;
    kind: string;
    billingMode: string;
    defaultCurrency: string;
    stripeCustomerId: string | null;
  };
  billingEntityId: string;
  externalTeamRefId?: string;
}

export interface GetTeamResult {
  id: string;
  name: string;
  kind: string;
  billingMode: string;
  defaultCurrency: string;
  stripeCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class TeamService {
  async createTeam(input: CreateTeamInput): Promise<CreateTeamResult> {
    const prisma = getPrismaClient();

    // Check if the App exists
    const app = await prisma.app.findUnique({ where: { id: input.appId } });
    if (!app) {
      throw new AppNotFoundError(input.appId);
    }

    // Idempotency: if externalTeamId is provided, check if mapping already exists
    if (input.externalTeamId) {
      const existingRef = await prisma.externalTeamRef.findUnique({
        where: {
          appId_externalTeamId: {
            appId: input.appId,
            externalTeamId: input.externalTeamId,
          },
        },
        include: {
          billingTeam: {
            include: { billingEntity: true },
          },
        },
      });

      if (existingRef) {
        return {
          team: {
            id: existingRef.billingTeam.id,
            name: existingRef.billingTeam.name,
            kind: existingRef.billingTeam.kind,
            billingMode: existingRef.billingTeam.billingMode,
            defaultCurrency: existingRef.billingTeam.defaultCurrency,
            stripeCustomerId: existingRef.billingTeam.stripeCustomerId,
          },
          billingEntityId: existingRef.billingTeam.billingEntity!.id,
          externalTeamRefId: existingRef.id,
        };
      }
    }

    // Create Team + BillingEntity + optional ExternalTeamRef in a transaction
    try {
      const result = await prisma.$transaction(async (tx) => {
        const team = await tx.team.create({
          data: {
            name: input.name,
            kind: "STANDARD",
            billingMode: "SUBSCRIPTION",
          },
        });

        const billingEntity = await tx.billingEntity.create({
          data: {
            type: "TEAM",
            teamId: team.id,
          },
        });

        let externalTeamRefId: string | undefined;

        if (input.externalTeamId) {
          const ref = await tx.externalTeamRef.create({
            data: {
              appId: input.appId,
              externalTeamId: input.externalTeamId,
              billingTeamId: team.id,
            },
          });
          externalTeamRefId = ref.id;
        }

        return {
          team: {
            id: team.id,
            name: team.name,
            kind: team.kind,
            billingMode: team.billingMode,
            defaultCurrency: team.defaultCurrency,
            stripeCustomerId: team.stripeCustomerId,
          },
          billingEntityId: billingEntity.id,
          externalTeamRefId,
        };
      });

      return result;
    } catch (err) {
      // P2002: unique constraint on appId+externalTeamId — created concurrently
      if (
        input.externalTeamId &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return this.findExistingTeamByExternalRef(prisma, input.appId, input.externalTeamId);
      }
      throw err;
    }
  }

  async getTeam(teamId: string): Promise<GetTeamResult | null> {
    const prisma = getPrismaClient();

    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      return null;
    }

    return {
      id: team.id,
      name: team.name,
      kind: team.kind,
      billingMode: team.billingMode,
      defaultCurrency: team.defaultCurrency,
      stripeCustomerId: team.stripeCustomerId,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
    };
  }

  private async findExistingTeamByExternalRef(
    prisma: ReturnType<typeof getPrismaClient>,
    appId: string,
    externalTeamId: string,
  ): Promise<CreateTeamResult> {
    const existingRef = await prisma.externalTeamRef.findUnique({
      where: {
        appId_externalTeamId: {
          appId,
          externalTeamId,
        },
      },
      include: {
        billingTeam: {
          include: { billingEntity: true },
        },
      },
    });

    return {
      team: {
        id: existingRef!.billingTeam.id,
        name: existingRef!.billingTeam.name,
        kind: existingRef!.billingTeam.kind,
        billingMode: existingRef!.billingTeam.billingMode,
        defaultCurrency: existingRef!.billingTeam.defaultCurrency,
        stripeCustomerId: existingRef!.billingTeam.stripeCustomerId,
      },
      billingEntityId: existingRef!.billingTeam.billingEntity!.id,
      externalTeamRefId: existingRef!.id,
    };
  }
}

export class AppNotFoundError extends Error {
  constructor(appId: string) {
    super(`App not found: ${appId}`);
    this.name = "AppNotFoundError";
  }
}

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}
