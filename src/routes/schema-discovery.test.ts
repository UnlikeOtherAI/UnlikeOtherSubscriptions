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

describe("GET /v1/schemas/usage-events", () => {
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

  it("returns all registered V1 event types", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/schemas/usage-events",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemas).toBeDefined();
    expect(Array.isArray(body.schemas)).toBe(true);

    const eventTypes = body.schemas
      .map((s: { eventType: string }) => s.eventType)
      .sort();
    expect(eventTypes).toEqual([
      "bandwidth.sample.v1",
      "llm.image.v1",
      "llm.tokens.v1",
      "storage.sample.v1",
    ]);
  });

  it("each schema entry contains eventType, version, status, and description", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/schemas/usage-events",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    for (const schema of body.schemas) {
      expect(schema).toHaveProperty("eventType");
      expect(schema).toHaveProperty("version");
      expect(schema).toHaveProperty("status");
      expect(schema).toHaveProperty("description");
      expect(typeof schema.eventType).toBe("string");
      expect(typeof schema.version).toBe("string");
      expect(typeof schema.status).toBe("string");
      expect(typeof schema.description).toBe("string");
    }
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/schemas/usage-events",
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("GET /v1/schemas/usage-events/:eventType", () => {
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

  it("returns valid JSON Schema for llm.tokens.v1", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/schemas/usage-events/llm.tokens.v1",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.eventType).toBe("llm.tokens.v1");
    expect(body.version).toBe("v1");
    expect(body.status).toBe("active");
    expect(body.description).toContain("token");
    expect(body.schema).toBeDefined();
    expect(body.schema.type).toBe("object");
    expect(body.schema.properties).toBeDefined();
    expect(body.schema.properties.provider).toEqual({ type: "string" });
    expect(body.schema.properties.model).toEqual({ type: "string" });
    expect(body.schema.properties.inputTokens).toEqual({ type: "integer" });
    expect(body.schema.properties.outputTokens).toEqual({ type: "integer" });
    expect(body.schema.properties.cachedTokens).toEqual({ type: "integer" });
    expect(body.schema.required).toContain("provider");
    expect(body.schema.required).toContain("model");
    expect(body.schema.required).toContain("inputTokens");
    expect(body.schema.required).toContain("outputTokens");
    expect(body.schema.required).not.toContain("cachedTokens");
    expect(body.schema.additionalProperties).toBe(true);
  });

  it("returns valid JSON Schema for llm.image.v1", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/schemas/usage-events/llm.image.v1",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.eventType).toBe("llm.image.v1");
    expect(body.schema.properties.width).toEqual({ type: "integer" });
    expect(body.schema.properties.height).toEqual({ type: "integer" });
    expect(body.schema.properties.count).toEqual({ type: "integer" });
    expect(body.schema.required).toContain("provider");
    expect(body.schema.required).toContain("model");
    expect(body.schema.required).toContain("width");
    expect(body.schema.required).toContain("height");
    expect(body.schema.required).toContain("count");
  });

  it("returns valid JSON Schema for storage.sample.v1", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/schemas/usage-events/storage.sample.v1",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.eventType).toBe("storage.sample.v1");
    expect(body.schema.properties.bytesUsed).toEqual({ type: "integer" });
    expect(body.schema.required).toContain("bytesUsed");
  });

  it("returns valid JSON Schema for bandwidth.sample.v1", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/schemas/usage-events/bandwidth.sample.v1",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.eventType).toBe("bandwidth.sample.v1");
    expect(body.schema.properties.bytesIn).toEqual({ type: "integer" });
    expect(body.schema.properties.bytesOut).toEqual({ type: "integer" });
    expect(body.schema.properties.bytesOutInternal).toEqual({ type: "integer" });
    expect(body.schema.required).toContain("bytesIn");
    expect(body.schema.required).toContain("bytesOut");
    expect(body.schema.required).not.toContain("bytesOutInternal");
  });

  it("returns 404 for unknown eventType", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/schemas/usage-events/unknown.thing.v1",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error).toBe("Not Found");
    expect(body.message).toContain("unknown.thing.v1");
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/schemas/usage-events/llm.tokens.v1",
    });

    expect(response.statusCode).toBe(401);
  });

  it("response format is stable across all schemas", async () => {
    const eventTypes = [
      "llm.tokens.v1",
      "llm.image.v1",
      "storage.sample.v1",
      "bandwidth.sample.v1",
    ];

    for (const eventType of eventTypes) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/schemas/usage-events/${eventType}`,
        headers: authHeaders(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Verify consistent response shape
      expect(body).toHaveProperty("eventType");
      expect(body).toHaveProperty("version");
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("description");
      expect(body).toHaveProperty("schema");
      expect(body.schema).toHaveProperty("$schema");
      expect(body.schema).toHaveProperty("type", "object");
      expect(body.schema).toHaveProperty("properties");
      expect(body.schema).toHaveProperty("additionalProperties", true);
    }
  });
});
