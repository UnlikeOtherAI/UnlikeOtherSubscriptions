import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  StripeService,
  TeamNotFoundError,
  NoStripeCustomerError,
} from "../services/stripe.service.js";

const portalParamSchema = z.object({
  appId: z.string().uuid(),
  teamId: z.string().uuid(),
});

const portalBodySchema = z.object({
  returnUrl: z.string().url(),
});

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  const stripeService = new StripeService();

  app.post(
    "/v1/apps/:appId/teams/:teamId/portal",
    async (request, reply) => {
      const params = portalParamSchema.parse(request.params);
      const body = portalBodySchema.parse(request.body);

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
        const result = await stripeService.createPortalSession(
          params.teamId,
          body.returnUrl,
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
        if (err instanceof NoStripeCustomerError) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "Team has no Stripe customer",
            statusCode: 400,
            requestId: request.requestId,
          });
        }
        throw err;
      }
    },
  );
}
