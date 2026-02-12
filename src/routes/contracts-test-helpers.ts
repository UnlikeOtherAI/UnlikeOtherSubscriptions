import Fastify, { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { registerCorrelationId } from "../middleware/correlation-id.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { registerAdminAuth } from "../middleware/admin-auth.js";
import { registerJwtAuth } from "../middleware/jwt-auth.js";
import { contractRoutes } from "./contracts.js";
import { bundleRoutes } from "./bundles.js";

export const TEST_ADMIN_API_KEY = "test-admin-api-key-secret";

export function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createTestJwt(
  secret: string,
  kid: string,
  appId: string,
  overrides: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT", kid };
  const payload = {
    iss: `app:${appId}`,
    aud: "billing-service",
    sub: `team:team-123`,
    appId,
    scopes: ["contracts:write", "bundles:write"],
    iat: now,
    exp: now + 300,
    jti: uuidv4(),
    kid,
    ...overrides,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

export function adminHeaders(): Record<string, string> {
  return { "x-admin-api-key": TEST_ADMIN_API_KEY };
}

export function buildContractTestApp(): FastifyInstance {
  const app = Fastify({ logger: false, requestIdHeader: false });
  registerCorrelationId(app);
  registerErrorHandler(app);
  registerAdminAuth(app);
  registerJwtAuth(app);
  app.register(contractRoutes);
  app.register(bundleRoutes);
  return app;
}
