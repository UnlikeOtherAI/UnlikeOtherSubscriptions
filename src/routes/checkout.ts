import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CheckoutService,
  PlanNotFoundError,
  TeamNotFoundError,
} from "../services/checkout.service.js";

const checkoutParamSchema = z.object({
  appId: z.string().uuid(),
  teamId: z.string().uuid(),
});

const subscriptionCheckoutBodySchema = z.object({
  planCode: z.string().min(1).max(255),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  seats: z.number().int().min(1).optional(),
});

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  const checkoutService = new CheckoutService();

  app.post(
    "/v1/apps/:appId/teams/:teamId/checkout/subscription",
    async (request, reply) => {
      const params = checkoutParamSchema.parse(request.params);
      const body = subscriptionCheckoutBodySchema.parse(request.body);

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
        const result = await checkoutService.createSubscriptionCheckout({
          appId: params.appId,
          teamId: params.teamId,
          planCode: body.planCode,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
          seats: body.seats,
        });

        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof PlanNotFoundError) {
          return reply.status(404).send({
            error: "Not Found",
            message: "Plan not found",
            statusCode: 404,
            requestId: request.requestId,
          });
        }
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
