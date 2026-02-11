import { FastifyInstance } from "fastify";
import { z } from "zod";
import { TeamService, AppNotFoundError } from "../services/team.service.js";

const appIdParamSchema = z.object({
  appId: z.string().uuid(),
});

const teamIdParamSchema = z.object({
  appId: z.string().uuid(),
  teamId: z.string().uuid(),
});

const createTeamBodySchema = z.object({
  name: z.string().min(1).max(255),
  externalTeamId: z.string().min(1).max(255).optional(),
});

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  const teamService = new TeamService();

  app.post("/v1/apps/:appId/teams", async (request, reply) => {
    const params = appIdParamSchema.parse(request.params);
    const body = createTeamBodySchema.parse(request.body);

    // Validate that appId in the JWT matches the route param
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
      const result = await teamService.createTeam({
        appId: params.appId,
        name: body.name,
        externalTeamId: body.externalTeamId,
      });

      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof AppNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: "App not found",
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });

  app.get("/v1/apps/:appId/teams/:teamId", async (request, reply) => {
    const params = teamIdParamSchema.parse(request.params);

    // Validate that appId in the JWT matches the route param
    const claims = request.jwtClaims;
    if (!claims || claims.appId !== params.appId) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "JWT appId does not match route appId",
        statusCode: 403,
        requestId: request.requestId,
      });
    }

    const team = await teamService.getTeam(params.teamId);
    if (!team) {
      return reply.status(404).send({
        error: "Not Found",
        message: "Team not found",
        statusCode: 404,
        requestId: request.requestId,
      });
    }

    return reply.status(200).send(team);
  });
}
