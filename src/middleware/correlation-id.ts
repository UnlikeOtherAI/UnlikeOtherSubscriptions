import { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";

export function registerCorrelationId(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && incoming.length > 0
        ? incoming
        : uuidv4();

    request.requestId = requestId;

    // Attach correlation ID to the Pino child logger
    request.log = request.log.child({ requestId });

    reply.header("x-request-id", requestId);
  });
}
