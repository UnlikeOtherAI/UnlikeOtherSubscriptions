import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  UsageEventService,
  AppNotFoundError,
  BatchTooLargeError,
  MissingTeamAndUserError,
  UserNotFoundError,
  PersonalTeamNotFoundError,
  BillingEntityNotFoundError,
  MAX_BATCH_SIZE,
} from "../services/usage-event.service.js";

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*\.v\d+$/;

const appIdParamSchema = z.object({
  appId: z.string().uuid(),
});

const usageEventSchema = z.object({
  idempotencyKey: z.string().min(1).max(255),
  eventType: z.string().min(1).regex(EVENT_TYPE_PATTERN, {
    message:
      "eventType must be a dot-separated lowercase string ending with a version (e.g. llm.tokens.v1)",
  }),
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()),
  source: z.string().min(1).max(255),
  teamId: z.string().uuid().optional(),
  userId: z.string().min(1).optional(),
});

const ingestBodySchema = z
  .array(usageEventSchema)
  .min(1, "At least one event is required")
  .max(MAX_BATCH_SIZE, `Batch size cannot exceed ${MAX_BATCH_SIZE}`);

export async function usageEventRoutes(app: FastifyInstance): Promise<void> {
  const usageEventService = new UsageEventService();

  app.post("/v1/apps/:appId/usage/events", async (request, reply) => {
    const params = appIdParamSchema.parse(request.params);
    const events = ingestBodySchema.parse(request.body);

    // Validate JWT appId matches route
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
      const result = await usageEventService.ingestEvents({
        appId: params.appId,
        events,
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
      if (err instanceof BatchTooLargeError) {
        return reply.status(400).send({
          error: "Bad Request",
          message: err.message,
          statusCode: 400,
          requestId: request.requestId,
        });
      }
      if (err instanceof MissingTeamAndUserError) {
        return reply.status(400).send({
          error: "Bad Request",
          message: err.message,
          statusCode: 400,
          requestId: request.requestId,
        });
      }
      if (err instanceof UserNotFoundError) {
        return reply.status(400).send({
          error: "Bad Request",
          message: err.message,
          statusCode: 400,
          requestId: request.requestId,
        });
      }
      if (
        err instanceof PersonalTeamNotFoundError ||
        err instanceof BillingEntityNotFoundError
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: err.message,
          statusCode: 400,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });
}
