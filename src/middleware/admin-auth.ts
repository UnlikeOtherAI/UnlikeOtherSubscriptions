import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";

const ADMIN_PREFIX = "/v1/admin/";

function getAdminApiKey(): string {
  const key = process.env.ADMIN_API_KEY;
  if (!key || key.length === 0) {
    throw new Error("ADMIN_API_KEY environment variable is not set");
  }
  return key;
}

function sendForbidden(reply: FastifyReply, message: string, requestId: string): void {
  void reply.status(403).send({
    error: "Forbidden",
    message,
    statusCode: 403,
    requestId,
  });
}

export function registerAdminAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.requestId ?? "unknown";
    const routePath = request.routeOptions?.url;

    const isAdmin =
      request.url.startsWith(ADMIN_PREFIX) ||
      (routePath !== undefined && routePath.startsWith(ADMIN_PREFIX));

    if (!isAdmin) {
      return;
    }

    const apiKey = request.headers["x-admin-api-key"];
    if (!apiKey || typeof apiKey !== "string") {
      return sendForbidden(reply, "Missing admin API key", requestId);
    }

    let expectedKey: string;
    try {
      expectedKey = getAdminApiKey();
    } catch {
      return sendForbidden(reply, "Admin access is not configured", requestId);
    }

    // Use timing-safe comparison to prevent timing attacks
    const apiKeyBuf = Buffer.from(apiKey);
    const expectedBuf = Buffer.from(expectedKey);

    if (apiKeyBuf.length !== expectedBuf.length || !timingSafeEqual(apiKeyBuf, expectedBuf)) {
      return sendForbidden(reply, "Invalid admin API key", requestId);
    }
  });
}
