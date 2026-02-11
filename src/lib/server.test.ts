import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildServer } from "../lib/server.js";
import type { FastifyInstance } from "fastify";

const { mockDisconnectPrisma, mockStopBoss } = vi.hoisted(() => ({
  mockDisconnectPrisma: vi.fn(),
  mockStopBoss: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => ({
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  }),
  disconnectPrisma: mockDisconnectPrisma,
}));

vi.mock("../lib/pg-boss.js", () => ({
  stopBoss: mockStopBoss,
}));

describe("Server", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
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

  it("shuts down gracefully calling Prisma disconnect and pg-boss stop", async () => {
    await app.close();

    expect(mockStopBoss).toHaveBeenCalledTimes(1);
    expect(mockDisconnectPrisma).toHaveBeenCalledTimes(1);
  });
});
