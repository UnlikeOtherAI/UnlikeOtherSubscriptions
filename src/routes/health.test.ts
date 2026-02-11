import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildServer } from "../lib/server.js";
import type { FastifyInstance } from "fastify";

// Mock the Prisma client
vi.mock("../lib/prisma.js", () => {
  const mockPrisma = {
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  };
  return {
    getPrismaClient: () => mockPrisma,
    disconnectPrisma: vi.fn(),
    __mockPrisma: mockPrisma,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPrisma: any;

beforeEach(async () => {
  const mod = await import("../lib/prisma.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma = (mod as any).__mockPrisma;
});

describe("GET /healthz", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 with status ok when database is reachable", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("returns 503 when database is unreachable", async () => {
    mockPrisma.$queryRaw.mockRejectedValueOnce(
      new Error("Connection refused")
    );

    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "error",
      message: "Database unreachable",
    });
  });

  it("includes x-request-id header in response", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    const requestId = response.headers["x-request-id"];
    expect(requestId).toBeDefined();
    expect(typeof requestId).toBe("string");
    expect((requestId as string).length).toBeGreaterThan(0);
  });

  it("propagates incoming x-request-id header", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    const incomingId = "test-correlation-id-123";

    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: {
        "x-request-id": incomingId,
      },
    });

    expect(response.headers["x-request-id"]).toBe(incomingId);
  });
});
