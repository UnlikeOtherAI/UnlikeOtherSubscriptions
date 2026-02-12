import Fastify, { FastifyInstance } from "fastify";
import { registerCorrelationId } from "../middleware/correlation-id.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { registerAdminAuth } from "../middleware/admin-auth.js";
import { registerJwtAuth } from "../middleware/jwt-auth.js";
import { topupRoutes } from "./topup.js";

export { createTestJwt, base64UrlEncode } from "./checkout-test-helpers.js";

export function buildTopupTestApp(): FastifyInstance {
  const app = Fastify({ logger: false, requestIdHeader: false });
  registerCorrelationId(app);
  registerErrorHandler(app);
  registerAdminAuth(app);
  registerJwtAuth(app);
  app.register(topupRoutes);
  return app;
}
