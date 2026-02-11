import { Prisma } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";

export interface AddMemberInput {
  teamId: string;
  userId: string;
  role?: "OWNER" | "ADMIN" | "MEMBER";
}

export interface AddMemberResult {
  member: {
    id: string;
    teamId: string;
    userId: string;
    role: string;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
  };
}

export interface RemoveMemberResult {
  member: {
    id: string;
    teamId: string;
    userId: string;
    role: string;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
  };
}

export class TeamMemberService {
  async addMember(input: AddMemberInput): Promise<AddMemberResult> {
    const prisma = getPrismaClient();

    const team = await prisma.team.findUnique({ where: { id: input.teamId } });
    if (!team) {
      throw new TeamNotFoundError(input.teamId);
    }

    const user = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) {
      throw new UserNotFoundError(input.userId);
    }

    // Idempotency: check if membership already exists
    const existing = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: input.teamId,
          userId: input.userId,
        },
      },
    });

    if (existing && existing.status === "ACTIVE") {
      return {
        member: {
          id: existing.id,
          teamId: existing.teamId,
          userId: existing.userId,
          role: existing.role,
          status: existing.status,
          startedAt: existing.startedAt,
          endedAt: existing.endedAt,
        },
      };
    }

    // Reactivate a previously removed membership
    if (existing && existing.status === "REMOVED") {
      const reactivated = await prisma.teamMember.update({
        where: {
          teamId_userId: {
            teamId: input.teamId,
            userId: input.userId,
          },
        },
        data: {
          status: "ACTIVE",
          endedAt: null,
          role: input.role ?? existing.role,
          startedAt: new Date(),
        },
      });

      return {
        member: {
          id: reactivated.id,
          teamId: reactivated.teamId,
          userId: reactivated.userId,
          role: reactivated.role,
          status: reactivated.status,
          startedAt: reactivated.startedAt,
          endedAt: reactivated.endedAt,
        },
      };
    }

    // Create new membership (handle P2002 for concurrent creates)
    try {
      const member = await prisma.teamMember.create({
        data: {
          teamId: input.teamId,
          userId: input.userId,
          role: input.role ?? "MEMBER",
          status: "ACTIVE",
        },
      });

      return {
        member: {
          id: member.id,
          teamId: member.teamId,
          userId: member.userId,
          role: member.role,
          status: member.status,
          startedAt: member.startedAt,
          endedAt: member.endedAt,
        },
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Concurrent create — re-read and handle (may be ACTIVE or REMOVED)
        const race = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: input.teamId,
              userId: input.userId,
            },
          },
        });

        if (race && race.status === "REMOVED") {
          const reactivated = await prisma.teamMember.update({
            where: {
              teamId_userId: {
                teamId: input.teamId,
                userId: input.userId,
              },
            },
            data: {
              status: "ACTIVE",
              endedAt: null,
              role: input.role ?? race.role,
              startedAt: new Date(),
            },
          });

          return {
            member: {
              id: reactivated.id,
              teamId: reactivated.teamId,
              userId: reactivated.userId,
              role: reactivated.role,
              status: reactivated.status,
              startedAt: reactivated.startedAt,
              endedAt: reactivated.endedAt,
            },
          };
        }

        return {
          member: {
            id: race!.id,
            teamId: race!.teamId,
            userId: race!.userId,
            role: race!.role,
            status: race!.status,
            startedAt: race!.startedAt,
            endedAt: race!.endedAt,
          },
        };
      }
      throw err;
    }
  }

  async removeMember(
    teamId: string,
    userId: string,
  ): Promise<RemoveMemberResult> {
    const prisma = getPrismaClient();

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new TeamNotFoundError(teamId);
    }

    const existing = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: { teamId, userId },
      },
    });

    if (!existing) {
      throw new MemberNotFoundError(teamId, userId);
    }

    if (existing.status === "REMOVED") {
      return {
        member: {
          id: existing.id,
          teamId: existing.teamId,
          userId: existing.userId,
          role: existing.role,
          status: existing.status,
          startedAt: existing.startedAt,
          endedAt: existing.endedAt,
        },
      };
    }

    const updated = await prisma.teamMember.update({
      where: {
        teamId_userId: { teamId, userId },
      },
      data: {
        status: "REMOVED",
        endedAt: new Date(),
      },
    });

    return {
      member: {
        id: updated.id,
        teamId: updated.teamId,
        userId: updated.userId,
        role: updated.role,
        status: updated.status,
        startedAt: updated.startedAt,
        endedAt: updated.endedAt,
      },
    };
  }

  async getActiveSeatCount(teamId: string): Promise<number> {
    const prisma = getPrismaClient();

    const count = await prisma.teamMember.count({
      where: {
        teamId,
        status: "ACTIVE",
      },
    });

    return count;
  }
}

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}

export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.name = "UserNotFoundError";
  }
}

export class MemberNotFoundError extends Error {
  constructor(teamId: string, userId: string) {
    super(`Member not found: team=${teamId}, user=${userId}`);
    this.name = "MemberNotFoundError";
  }
}
