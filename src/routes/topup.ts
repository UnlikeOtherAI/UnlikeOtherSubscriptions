import { FastifyInstance } from "fastify";
import { z } from "zod";
import { TopupService, TeamNotFoundError } from "../services/topup.service.js";

const topupParamSchema = z.object({
  appId: z.string().uuid(),
  teamId: z.string().uuid(),
});

const topupCheckoutBodySchema = z.object({
  amountMinor: z.number().int().min(1),
  currency: z.string().min(1).max(10),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export async function topupRoutes(app: FastifyInstance): Promise<void> {
  const topupService = new TopupService();

  app.post(
    "/v1/apps/:appId/teams/:teamId/checkout/topup",
    async (request, reply) => {
      const params = topupParamSchema.parse(request.params);
      const body = topupCheckoutBodySchema.parse(request.body);

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
        const result = await topupService.createTopupCheckout({
          appId: params.appId,
          teamId: params.teamId,
          amountMinor: body.amountMinor,
          currency: body.currency,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
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
        throw err;
      }
    },
  );
}
