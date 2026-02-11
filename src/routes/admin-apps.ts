import { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppService } from "../services/app.service.js";

const createAppSchema = z.object({
  name: z.string().min(1).max(255),
});

const appIdParamSchema = z.object({
  appId: z.string().uuid(),
});

const revokeSecretParamSchema = z.object({
  appId: z.string().uuid(),
  kid: z.string().min(1),
});

export async function adminAppRoutes(app: FastifyInstance): Promise<void> {
  const appService = new AppService();

  app.post("/v1/admin/apps", async (request, reply) => {
    const body = createAppSchema.parse(request.body);
    const result = await appService.createApp(body.name);
    return reply.status(201).send(result);
  });

  app.post("/v1/admin/apps/:appId/secrets", async (request, reply) => {
    const params = appIdParamSchema.parse(request.params);
    const result = await appService.generateSecret(params.appId);

    if (!result) {
      return reply.status(404).send({
        error: "Not Found",
        message: "App not found",
        statusCode: 404,
        requestId: request.requestId,
      });
    }

    return reply.status(201).send(result);
  });

  app.delete("/v1/admin/apps/:appId/secrets/:kid", async (request, reply) => {
    const params = revokeSecretParamSchema.parse(request.params);
    const revoked = await appService.revokeSecret(params.appId, params.kid);

    if (!revoked) {
      return reply.status(404).send({
        error: "Not Found",
        message: "Secret not found",
        statusCode: 404,
        requestId: request.requestId,
      });
    }

    return reply.status(200).send({ message: "Secret revoked" });
  });
}
