import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { registerCorrelationId } from "./correlation-id.js";
import { registerErrorHandler } from "./error-handler.js";

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

function buildTestServer(): FastifyInstance {
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
  });

  registerCorrelationId(app);
  registerErrorHandler(app);

  return app;
}

describe("Error handler", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildTestServer();

    // Register a test route that throws a ZodError
    app.get("/test/zod-error", async () => {
      const schema = z.object({
        name: z.string(),
        age: z.number().min(18),
      });
      schema.parse({ name: 123, age: "not-a-number" });
    });

    // Register a test route that throws an unknown error
    app.get("/test/unknown-error", async () => {
      throw new Error("Something went wrong");
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 400 with structured response for Zod validation errors", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/zod-error",
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe("Validation Error");
    expect(body.message).toBe("Request validation failed");
    expect(body.statusCode).toBe(400);
    expect(body.requestId).toBeDefined();
    expect(body.issues).toBeDefined();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("returns 500 with correlation ID for unknown errors", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/unknown-error",
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBe("Internal Server Error");
    expect(body.message).toBe("An unexpected error occurred");
    expect(body.statusCode).toBe(500);
    expect(body.requestId).toBeDefined();
    expect(typeof body.requestId).toBe("string");
  });

  it("includes correlation ID in 400 error responses", async () => {
    const customId = "my-custom-request-id";
    const response = await app.inject({
      method: "GET",
      url: "/test/zod-error",
      headers: {
        "x-request-id": customId,
      },
    });

    const body = response.json();
    expect(body.requestId).toBe(customId);
    expect(response.headers["x-request-id"]).toBe(customId);
  });

  it("includes correlation ID in 500 error responses", async () => {
    const customId = "error-request-id";
    const response = await app.inject({
      method: "GET",
      url: "/test/unknown-error",
      headers: {
        "x-request-id": customId,
      },
    });

    const body = response.json();
    expect(body.requestId).toBe(customId);
  });
});
