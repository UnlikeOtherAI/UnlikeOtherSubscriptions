import { FastifyInstance } from "fastify";
import { z } from "zod";
import { UserService, AppNotFoundError } from "../services/user.service.js";

const appIdParamSchema = z.object({
  appId: z.string().uuid(),
});

const createUserBodySchema = z.object({
  email: z.string().email(),
  externalRef: z.string().min(1).max(255),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const userService = new UserService();

  app.post("/v1/apps/:appId/users", async (request, reply) => {
    const params = appIdParamSchema.parse(request.params);
    const body = createUserBodySchema.parse(request.body);

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
      const result = await userService.provisionUser({
        appId: params.appId,
        email: body.email,
        externalRef: body.externalRef,
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
}
