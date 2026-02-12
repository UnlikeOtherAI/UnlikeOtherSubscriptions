import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  createTestJwt,
  buildUsageEventTestApp,
} from "./usage-events-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();
const TEST_TEAM_ID = uuidv4();
const TEST_BILLING_ENTITY_ID = uuidv4();

let usageEvents: Map<string, Record<string, unknown>>;

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    team: { findFirst: vi.fn() },
    billingEntity: { findUnique: vi.fn() },
    usageEvent: { create: vi.fn() },
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

function makeP2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`appId`,`idempotencyKey`)",
    {
      code: "P2002",
      clientVersion: "6.3.1",
      meta: { target: ["appId", "idempotencyKey"] },
    },
  );
}

function setupMocks(): void {
  mockPrisma.app.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === TEST_APP_ID) {
        return Promise.resolve({ id: TEST_APP_ID, name: "Test App", status: "ACTIVE" });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.appSecret.findUnique.mockImplementation(
    ({ where }: { where: { kid: string } }) => {
      if (where.kid === TEST_KID) {
        return Promise.resolve({
          id: uuidv4(), appId: TEST_APP_ID, kid: TEST_KID,
          secretHash: `encrypted:${TEST_SECRET}`, status: "ACTIVE",
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.jtiUsage.create.mockResolvedValue({});

  mockPrisma.billingEntity.findUnique.mockImplementation(
    ({ where }: { where: { teamId: string } }) => {
      if (where.teamId === TEST_TEAM_ID) {
        return Promise.resolve({ id: TEST_BILLING_ENTITY_ID, type: "TEAM", teamId: TEST_TEAM_ID });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.team.findFirst.mockResolvedValue(null);

  mockPrisma.usageEvent.create.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) => {
      const key = `${data.appId}:${data.idempotencyKey}`;
      if (usageEvents.has(key)) throw makeP2002Error();
      const id = uuidv4();
      const record = { id, ...data, createdAt: new Date() };
      usageEvents.set(key, record);
      return Promise.resolve(record);
    },
  );
}

function authHeaders(): Record<string, string> {
  const jwt = createTestJwt(TEST_SECRET, TEST_KID, TEST_APP_ID);
  return { authorization: `Bearer ${jwt}` };
}

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: uuidv4(),
    eventType: "llm.tokens.v1",
    timestamp: new Date().toISOString(),
    payload: { provider: "openai", model: "gpt-5", inputTokens: 1200, outputTokens: 350 },
    source: "test-tool/1.0.0",
    teamId: TEST_TEAM_ID,
    ...overrides,
  };
}

describe("POST /v1/apps/:appId/usage/events — schema validation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    usageEvents = new Map();
    setupMocks();
    app = buildUsageEventTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  // ── Unknown eventType rejection ────────────────────────────────

  it("returns 400 for unknown eventType", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "custom.unknown.v1",
        payload: { foo: "bar" },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe("Bad Request");
    expect(body.message).toContain("Unknown event type");
    expect(body.message).toContain("custom.unknown.v1");
    expect(body.eventType).toBe("custom.unknown.v1");
  });

  it("returns 400 for unknown eventType even with valid format", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "llm.tokens.v99",
        payload: { provider: "openai", model: "gpt-5", inputTokens: 1, outputTokens: 1 },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("Unknown event type");
  });

  // ── llm.tokens.v1 payload validation ───────────────────────────

  it("accepts valid llm.tokens.v1 payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "llm.tokens.v1",
        payload: { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50 },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
  });

  it("returns 400 with field-level errors for llm.tokens.v1 missing required fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "llm.tokens.v1",
        payload: { model: "gpt-5" },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.validationErrors).toBeDefined();
    expect(Array.isArray(body.validationErrors)).toBe(true);

    const fields = body.validationErrors.map((e: { field: string }) => e.field);
    expect(fields).toContain("provider");
    expect(fields).toContain("inputTokens");
    expect(fields).toContain("outputTokens");
  });

  it("tolerates extra fields in llm.tokens.v1 payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "llm.tokens.v1",
        payload: {
          provider: "openai", model: "gpt-5",
          inputTokens: 100, outputTokens: 50,
          customField: "extra", debugInfo: { nested: true },
        },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
  });

  // ── llm.image.v1 payload validation ────────────────────────────

  it("accepts valid llm.image.v1 payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "llm.image.v1",
        payload: { provider: "openai", model: "dall-e-3", width: 1024, height: 1024, count: 1 },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
  });

  it("returns 400 for llm.image.v1 missing required fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "llm.image.v1",
        payload: { provider: "openai" },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.validationErrors).toBeDefined();
    const fields = body.validationErrors.map((e: { field: string }) => e.field);
    expect(fields).toContain("model");
    expect(fields).toContain("width");
    expect(fields).toContain("height");
    expect(fields).toContain("count");
  });

  // ── storage.sample.v1 payload validation ───────────────────────

  it("accepts valid storage.sample.v1 payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "storage.sample.v1",
        payload: { bytesUsed: 1048576 },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
  });

  it("returns 400 for storage.sample.v1 missing bytesUsed", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "storage.sample.v1",
        payload: {},
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.validationErrors).toBeDefined();
    const fields = body.validationErrors.map((e: { field: string }) => e.field);
    expect(fields).toContain("bytesUsed");
  });

  // ── bandwidth.sample.v1 payload validation ─────────────────────

  it("accepts valid bandwidth.sample.v1 payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "bandwidth.sample.v1",
        payload: { bytesIn: 5000, bytesOut: 12000 },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
  });

  it("accepts bandwidth.sample.v1 with optional bytesOutInternal", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "bandwidth.sample.v1",
        payload: { bytesIn: 5000, bytesOut: 12000, bytesOutInternal: 3000 },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
  });

  it("returns 400 for bandwidth.sample.v1 missing required fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "bandwidth.sample.v1",
        payload: { bytesIn: 5000 },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.validationErrors).toBeDefined();
    const fields = body.validationErrors.map((e: { field: string }) => e.field);
    expect(fields).toContain("bytesOut");
  });

  // ── Response structure ─────────────────────────────────────────

  it("includes eventType in error response for unknown types", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "audit.login.v1",
        payload: { userId: "user-1" },
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.eventType).toBe("audit.login.v1");
  });

  it("includes eventType and validationErrors in error response for invalid payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({
        eventType: "llm.tokens.v1",
        payload: {},
      })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.eventType).toBe("llm.tokens.v1");
    expect(body.validationErrors).toBeDefined();
    expect(body.validationErrors.length).toBeGreaterThan(0);
    for (const err of body.validationErrors) {
      expect(err).toHaveProperty("field");
      expect(err).toHaveProperty("message");
    }
  });
});
