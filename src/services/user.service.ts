import { getPrismaClient } from "../lib/prisma.js";

export interface ProvisionUserInput {
  appId: string;
  email: string;
  externalRef: string;
}

export interface ProvisionUserResult {
  user: {
    id: string;
    appId: string;
    email: string;
    externalRef: string;
  };
  personalTeamId: string;
}

export class UserService {
  async provisionUser(input: ProvisionUserInput): Promise<ProvisionUserResult> {
    const prisma = getPrismaClient();

    // Check if the App exists
    const app = await prisma.app.findUnique({ where: { id: input.appId } });
    if (!app) {
      throw new AppNotFoundError(input.appId);
    }

    // Check if the user already exists (idempotent on appId+externalRef)
    const existingUser = await prisma.user.findUnique({
      where: {
        appId_externalRef: {
          appId: input.appId,
          externalRef: input.externalRef,
        },
      },
    });

    if (existingUser) {
      // Return existing records without modification
      const personalTeam = await prisma.team.findFirst({
        where: {
          kind: "PERSONAL",
          ownerUserId: existingUser.id,
        },
      });

      return {
        user: {
          id: existingUser.id,
          appId: existingUser.appId,
          email: existingUser.email,
          externalRef: existingUser.externalRef,
        },
        personalTeamId: personalTeam!.id,
      };
    }

    // Create User + Personal Team + BillingEntity + TeamMember in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          appId: input.appId,
          email: input.email,
          externalRef: input.externalRef,
        },
      });

      const team = await tx.team.create({
        data: {
          name: `${input.email}'s Personal Team`,
          kind: "PERSONAL",
          ownerUserId: user.id,
          billingMode: "SUBSCRIPTION",
        },
      });

      await tx.billingEntity.create({
        data: {
          type: "TEAM",
          teamId: team.id,
        },
      });

      await tx.teamMember.create({
        data: {
          teamId: team.id,
          userId: user.id,
          role: "OWNER",
          status: "ACTIVE",
        },
      });

      return {
        user: {
          id: user.id,
          appId: user.appId,
          email: user.email,
          externalRef: user.externalRef,
        },
        personalTeamId: team.id,
      };
    });

    return result;
  }
}

export class AppNotFoundError extends Error {
  constructor(appId: string) {
    super(`App not found: ${appId}`);
    this.name = "AppNotFoundError";
  }
}
