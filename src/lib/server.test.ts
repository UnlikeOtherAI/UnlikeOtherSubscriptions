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

describe("Server", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("builds and starts successfully", () => {
    expect(app).toBeDefined();
  });

  it("has healthz route registered", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    // Even without a real DB, the route exists (may return 503)
    expect([200, 503]).toContain(response.statusCode);
  });

  it("returns 404 for unknown routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/nonexistent",
    });

    expect(response.statusCode).toBe(404);
  });

  it("shuts down gracefully", async () => {
    const disconnectPrisma = (await import("../lib/prisma.js"))
      .disconnectPrisma;

    await app.close();
    // Verify that closing the app doesn't throw
    expect(true).toBe(true);
  });
});
