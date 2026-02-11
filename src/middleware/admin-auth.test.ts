import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { registerCorrelationId } from "./correlation-id.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerAdminAuth } from "./admin-auth.js";

const TEST_ADMIN_API_KEY = "secure-admin-key-for-testing";

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => ({
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  }),
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/pg-boss.js", () => ({
  stopBoss: vi.fn(),
}));

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false, requestIdHeader: false });
  registerCorrelationId(app);
  registerErrorHandler(app);
  registerAdminAuth(app);

  app.post("/v1/admin/apps", async () => {
    return { created: true };
  });

  app.get("/v1/admin/apps/:appId/secrets", async () => {
    return { secrets: [] };
  });

  app.get("/v1/public/data", async () => {
    return { public: true };
  });

  return app;
}

describe("Admin Auth middleware", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
  });

  it("allows requests with valid admin API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
      headers: { "x-admin-api-key": TEST_ADMIN_API_KEY },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().created).toBe(true);
  });

  it("returns 403 when admin API key is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Missing admin API key");
  });

  it("returns 403 when admin API key is invalid", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
      headers: { "x-admin-api-key": "wrong-key" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Invalid admin API key");
  });

  it("does not affect non-admin routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/public/data",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().public).toBe(true);
  });

  it("protects parameterized admin routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/apps/some-uuid/secrets",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Missing admin API key");
  });

  it("includes requestId in 403 error responses", async () => {
    const customId = "custom-req-id-403";
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
      headers: { "x-request-id": customId },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().requestId).toBe(customId);
  });

  it("returns 403 when ADMIN_API_KEY env var is not set", async () => {
    delete process.env.ADMIN_API_KEY;

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
      headers: { "x-admin-api-key": "some-key" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Admin access is not configured");
  });
});
