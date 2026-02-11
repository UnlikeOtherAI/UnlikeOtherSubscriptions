import Fastify, { FastifyInstance } from "fastify";
import { registerCorrelationId } from "../middleware/correlation-id.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { registerAdminAuth } from "../middleware/admin-auth.js";
import { registerJwtAuth } from "../middleware/jwt-auth.js";
import { healthRoutes } from "../routes/health.js";
import { adminAppRoutes } from "../routes/admin-apps.js";
import { disconnectPrisma } from "./prisma.js";
import { stopBoss } from "./pg-boss.js";

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
  registerAdminAuth(app);
  registerJwtAuth(app);

  app.register(healthRoutes);
  app.register(adminAppRoutes);

  app.addHook("onClose", async () => {
    await stopBoss();
    await disconnectPrisma();
  });

  return app;
}
