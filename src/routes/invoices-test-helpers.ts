import Fastify, { FastifyInstance } from "fastify";
import { registerCorrelationId } from "../middleware/correlation-id.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { registerAdminAuth } from "../middleware/admin-auth.js";
import { registerJwtAuth } from "../middleware/jwt-auth.js";
import { invoiceRoutes } from "./invoices.js";

export const TEST_ADMIN_API_KEY = "test-admin-api-key-secret";

export function adminHeaders(): Record<string, string> {
  return { "x-admin-api-key": TEST_ADMIN_API_KEY };
}

export function buildInvoiceTestApp(): FastifyInstance {
  const app = Fastify({ logger: false, requestIdHeader: false });
  registerCorrelationId(app);
  registerErrorHandler(app);
  registerAdminAuth(app);
  registerJwtAuth(app);
  app.register(invoiceRoutes);
  return app;
}
