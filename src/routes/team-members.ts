import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  TeamMemberService,
  TeamNotFoundError,
  UserNotFoundError,
  MemberNotFoundError,
} from "../services/team-member.service.js";

const teamMemberParamSchema = z.object({
  appId: z.string().uuid(),
  teamId: z.string().uuid(),
});

const removeMemberParamSchema = z.object({
  appId: z.string().uuid(),
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
});

const addMemberBodySchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["OWNER", "ADMIN", "MEMBER"]).optional(),
});

export async function teamMemberRoutes(app: FastifyInstance): Promise<void> {
  const memberService = new TeamMemberService();

  app.post(
    "/v1/apps/:appId/teams/:teamId/users",
    async (request, reply) => {
      const params = teamMemberParamSchema.parse(request.params);
      const body = addMemberBodySchema.parse(request.body);

      const claims = request.jwtClaims;
      if (!claims || claims.appId !== params.appId) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "JWT appId does not match route appId",
          statusCode: 403,
          requestId: request.requestId,
        });
      }

      try {
        const result = await memberService.addMember({
          teamId: params.teamId,
          userId: body.userId,
          role: body.role,
        });

        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof TeamNotFoundError) {
          return reply.status(404).send({
            error: "Not Found",
            message: "Team not found",
            statusCode: 404,
            requestId: request.requestId,
          });
        }
        if (err instanceof UserNotFoundError) {
          return reply.status(404).send({
            error: "Not Found",
            message: "User not found",
            statusCode: 404,
            requestId: request.requestId,
          });
        }
        throw err;
      }
    },
  );

  app.delete(
    "/v1/apps/:appId/teams/:teamId/users/:userId",
    async (request, reply) => {
      const params = removeMemberParamSchema.parse(request.params);

      const claims = request.jwtClaims;
      if (!claims || claims.appId !== params.appId) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "JWT appId does not match route appId",
          statusCode: 403,
          requestId: request.requestId,
        });
      }

      try {
        const result = await memberService.removeMember(
          params.teamId,
          params.userId,
        );

        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof TeamNotFoundError) {
          return reply.status(404).send({
            error: "Not Found",
            message: "Team not found",
            statusCode: 404,
            requestId: request.requestId,
          });
        }
        if (err instanceof MemberNotFoundError) {
          return reply.status(404).send({
            error: "Not Found",
            message: "Member not found",
            statusCode: 404,
            requestId: request.requestId,
          });
        }
        throw err;
      }
    },
  );
}
