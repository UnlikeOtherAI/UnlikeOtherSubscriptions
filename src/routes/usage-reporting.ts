import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  UsageReportingService,
  TeamNotFoundError,
  BillingEntityNotFoundError,
} from "../services/usage-reporting.service.js";

const VALID_GROUP_BY = ["app", "meter", "provider", "model"] as const;

const paramsSchema = z.object({
  teamId: z.string().uuid(),
});

const usageQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  groupBy: z.enum(VALID_GROUP_BY),
});

const cogsQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
}

export async function usageReportingRoutes(
  app: FastifyInstance,
): Promise<void> {
  const service = new UsageReportingService();

  app.get("/v1/teams/:teamId/usage", async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const query = usageQuerySchema.parse(request.query);

    const claims = request.jwtClaims;
    if (!claims) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Missing authentication",
        statusCode: 401,
        requestId: request.requestId,
      });
    }

    if (!hasScope(claims.scopes, "billing:read")) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Insufficient scopes: billing:read required",
        statusCode: 403,
        requestId: request.requestId,
      });
    }

    try {
      const result = await service.getUsageReport(params.teamId, {
        from: new Date(query.from),
        to: new Date(query.to),
        groupBy: query.groupBy,
      });

      return reply.status(200).send(result);
    } catch (err) {
      if (
        err instanceof TeamNotFoundError ||
        err instanceof BillingEntityNotFoundError
      ) {
        return reply.status(404).send({
          error: "Not Found",
          message: err.message,
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });

  app.get("/v1/teams/:teamId/cogs", async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const query = cogsQuerySchema.parse(request.query);

    const claims = request.jwtClaims;
    if (!claims) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Missing authentication",
        statusCode: 401,
        requestId: request.requestId,
      });
    }

    if (!hasScope(claims.scopes, "billing:read")) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Insufficient scopes: billing:read required",
        statusCode: 403,
        requestId: request.requestId,
      });
    }

    try {
      const result = await service.getCogsReport(params.teamId, {
        from: new Date(query.from),
        to: new Date(query.to),
      });

      return reply.status(200).send(result);
    } catch (err) {
      if (
        err instanceof TeamNotFoundError ||
        err instanceof BillingEntityNotFoundError
      ) {
        return reply.status(404).send({
          error: "Not Found",
          message: err.message,
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });
}
