import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { registerCorrelationId } from "./correlation-id.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerAdminAuth } from "./admin-auth.js";
import { registerJwtAuth } from "./jwt-auth.js";
import { encryptSecret } from "../lib/crypto.js";

const TEST_SECRET = "test-hmac-secret-key-that-is-long-enough";
const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_ADMIN_API_KEY = "test-admin-api-key";

const { mockFindUnique, mockJtiCreate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockJtiCreate: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => ({
    appSecret: { findUnique: mockFindUnique },
    jtiUsage: { create: mockJtiCreate },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  }),
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/pg-boss.js", () => ({ stopBoss: vi.fn() }));

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false, requestIdHeader: false });
  registerCorrelationId(app);
  registerErrorHandler(app);
  registerAdminAuth(app);
  registerJwtAuth(app);

  app.get("/v1/test/protected", async (request) => ({ claims: request.jwtClaims }));
  app.get("/healthz", async () => ({ status: "ok" }));
  app.post("/v1/stripe/webhook", async () => ({ received: true }));
  app.get("/v1/admin/test", async () => ({ admin: true }));

  return app;
}

describe("JWT Auth middleware — route bypasses", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;

    const encryptedSecret = encryptSecret(TEST_SECRET);
    mockFindUnique.mockResolvedValue(null);
    mockJtiCreate.mockResolvedValue({ jti: "test", expiresAt: new Date() });

    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.ADMIN_API_KEY;
  });

  it("bypasses JWT check for /healthz route", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
  });

  it("bypasses JWT check for /v1/stripe/webhook route", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/stripe/webhook" });
    expect(response.statusCode).toBe(200);
    expect(response.json().received).toBe(true);
  });

  it("bypasses JWT check for /v1/admin/ routes (secured by admin API key)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/test",
      headers: { "x-admin-api-key": TEST_ADMIN_API_KEY },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().admin).toBe(true);
  });
});
