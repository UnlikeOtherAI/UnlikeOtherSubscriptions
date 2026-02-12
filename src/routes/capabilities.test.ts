import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  createTestJwt,
  buildSchemaDiscoveryTestApp,
} from "./schema-discovery-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    appSecret: { findUnique: vi.fn() },
    jtiUsage: { create: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../lib/pg-boss.js", () => ({ stopBoss: vi.fn() }));

vi.mock("../lib/crypto.js", () => ({
  encryptSecret: (s: string) => `encrypted:${s}`,
  decryptSecret: (s: string) => s.replace("encrypted:", ""),
}));

function setupMocks(): void {
  mockPrisma.appSecret.findUnique.mockImplementation(
    ({ where }: { where: { kid: string } }) => {
      if (where.kid === TEST_KID) {
        return Promise.resolve({
          id: uuidv4(),
          appId: TEST_APP_ID,
          kid: TEST_KID,
          secretHash: `encrypted:${TEST_SECRET}`,
          status: "ACTIVE",
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.jtiUsage.create.mockResolvedValue({});
}

function authHeaders(
  overrides: Record<string, unknown> = {},
): Record<string, string> {
  const jwt = createTestJwt(TEST_SECRET, TEST_KID, TEST_APP_ID, overrides);
  return { authorization: `Bearer ${jwt}` };
}

describe("GET /v1/meta/capabilities", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    setupMocks();
    app = buildSchemaDiscoveryTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("returns correct max batch size", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/meta/capabilities",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.usageIngestion).toBeDefined();
    expect(body.usageIngestion.maxBatchSize).toBe(1000);
  });

  it("includes all supported event types", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/meta/capabilities",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    const eventTypes = body.usageIngestion.supportedEventTypes
      .map((e: { eventType: string }) => e.eventType)
      .sort();

    expect(eventTypes).toEqual([
      "bandwidth.sample.v1",
      "llm.image.v1",
      "llm.tokens.v1",
      "storage.sample.v1",
    ]);
  });

  it("each event type entry has eventType, version, and status", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/meta/capabilities",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    for (const et of body.usageIngestion.supportedEventTypes) {
      expect(et).toHaveProperty("eventType");
      expect(et).toHaveProperty("version");
      expect(et).toHaveProperty("status");
    }
  });

  it("returns available meters", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/meta/capabilities",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meters).toBeDefined();
    expect(Array.isArray(body.meters)).toBe(true);
    expect(body.meters.sort()).toEqual([
      "bandwidth.sample",
      "llm.image",
      "llm.tokens",
      "storage.sample",
    ]);
  });

  it("returns api version", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/meta/capabilities",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.apiVersion).toBe("v1");
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/meta/capabilities",
    });

    expect(response.statusCode).toBe(401);
  });
});
