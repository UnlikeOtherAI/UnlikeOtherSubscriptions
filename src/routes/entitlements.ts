import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  EntitlementService,
  TeamNotFoundError,
} from "../services/entitlement.service.js";

const paramsSchema = z.object({
  appId: z.string().uuid(),
  teamId: z.string().uuid(),
});

export async function entitlementRoutes(app: FastifyInstance): Promise<void> {
  const entitlementService = new EntitlementService();

  app.get(
    "/v1/apps/:appId/teams/:teamId/entitlements",
    async (request, reply) => {
      const params = paramsSchema.parse(request.params);

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
        const result = await entitlementService.resolveEntitlements(
          params.appId,
          params.teamId,
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
        throw err;
      }
    },
  );
}
