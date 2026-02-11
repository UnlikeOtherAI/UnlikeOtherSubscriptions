import Fastify, { FastifyInstance } from "fastify";
import { registerCorrelationId } from "../middleware/correlation-id.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { healthRoutes } from "../routes/health.js";

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "development"
          ? { target: "pino-pretty" }
          : undefined,
    },
    disableRequestLogging: false,
    requestIdHeader: false, // We handle request IDs ourselves
  });

  registerCorrelationId(app);
  registerErrorHandler(app);

  app.register(healthRoutes);

  return app;
}
