import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildServer } from "../lib/server.js";
import type { FastifyInstance } from "fastify";

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => ({
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  }),
  disconnectPrisma: vi.fn(),
}));

describe("Correlation ID middleware", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildServer();

    app.get("/test/echo-request-id", async (request, reply) => {
      return { requestId: request.requestId };
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("generates a UUID request ID when none is provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/echo-request-id",
    });

    const body = response.json();
    const headerRequestId = response.headers["x-request-id"] as string;

    expect(headerRequestId).toBeDefined();
    // UUID v4 format
    expect(headerRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(body.requestId).toBe(headerRequestId);
  });

  it("propagates incoming x-request-id", async () => {
    const incomingId = "custom-id-12345";
    const response = await app.inject({
      method: "GET",
      url: "/test/echo-request-id",
      headers: {
        "x-request-id": incomingId,
      },
    });

    const body = response.json();
    expect(response.headers["x-request-id"]).toBe(incomingId);
    expect(body.requestId).toBe(incomingId);
  });

  it("generates new ID when x-request-id header is empty", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/echo-request-id",
      headers: {
        "x-request-id": "",
      },
    });

    const headerRequestId = response.headers["x-request-id"] as string;
    expect(headerRequestId).toBeDefined();
    expect(headerRequestId.length).toBeGreaterThan(0);
  });

  it("includes request ID on every response", async () => {
    // Make multiple requests and verify each has a unique ID
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/test/echo-request-id" }),
      app.inject({ method: "GET", url: "/test/echo-request-id" }),
      app.inject({ method: "GET", url: "/test/echo-request-id" }),
    ]);

    const ids = responses.map(
      (r) => r.headers["x-request-id"] as string
    );
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(3);
    ids.forEach((id) => {
      expect(id).toBeDefined();
      expect(id.length).toBeGreaterThan(0);
    });
  });
});
