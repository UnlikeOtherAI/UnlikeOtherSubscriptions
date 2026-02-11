import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  TEST_ADMIN_API_KEY,
  adminHeaders,
  buildTestApp,
} from "./admin-apps-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");

let apps: Map<string, { id: string; name: string; status: string; createdAt: Date; updatedAt: Date }>;

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: { create: vi.fn(), findUnique: vi.fn() },
    appSecret: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    jtiUsage: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/pg-boss.js", () => ({ stopBoss: vi.fn() }));

describe("POST /v1/admin/apps", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    apps = new Map();

    mockPrisma.app.create.mockImplementation(({ data }: { data: { name: string } }) => {
      const id = uuidv4();
      const record = { id, name: data.name, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() };
      apps.set(id, record);
      return Promise.resolve(record);
    });

    mockPrisma.app.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(apps.get(where.id) ?? null));

    app = buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("creates an App and returns valid appId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
      payload: { name: "My Test App" },
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
    expect(body.name).toBe("My Test App");
    expect(body.status).toBe("ACTIVE");
  });

  it("returns 400 for missing name", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
      payload: {},
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for empty name", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
      payload: { name: "" },
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 403 without admin API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
      payload: { name: "No Auth" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Missing admin API key");
  });

  it("returns 403 with invalid admin API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/apps",
      payload: { name: "Bad Auth" },
      headers: { "x-admin-api-key": "wrong-key" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Invalid admin API key");
  });
});
