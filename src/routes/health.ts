import { FastifyInstance } from "fastify";
import { getPrismaClient } from "../lib/prisma.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async (request, reply) => {
    try {
      await getPrismaClient().$queryRaw`SELECT 1`;
      return reply.status(200).send({ status: "ok" });
    } catch (err) {
      request.log.error({ err }, "Health check failed: database unreachable");
      return reply
        .status(503)
        .send({ status: "error", message: "Database unreachable" });
    }
  });
}
