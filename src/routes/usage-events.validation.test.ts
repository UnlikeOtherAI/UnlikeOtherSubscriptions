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

function authHeaders(appIdOverride?: string): Record<string, string> {
  const jwt = createTestJwt(TEST_SECRET, TEST_KID, appIdOverride ?? TEST_APP_ID);
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

describe("POST /v1/apps/:appId/usage/events — validation & errors", () => {
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

  it("returns 400 when both teamId and userId are missing", async () => {
    const event = makeEvent({ teamId: undefined, userId: undefined });
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [event],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("teamId or userId");
  });

  it("returns 400 for invalid eventType format", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({ eventType: "INVALID-FORMAT" })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for empty batch", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for batch exceeding max size", async () => {
    const events = Array.from({ length: 1001 }, () => makeEvent());
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: events,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 403 when JWT appId does not match route appId", async () => {
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${differentAppId}/usage/events`,
      payload: [makeEvent()],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("JWT appId does not match route appId");
  });

  it("returns 404 when App does not exist", async () => {
    const nonexistentAppId = uuidv4();
    mockPrisma.appSecret.findUnique.mockImplementation(
      ({ where }: { where: { kid: string } }) => {
        if (where.kid === TEST_KID) {
          return Promise.resolve({
            id: uuidv4(), appId: nonexistentAppId, kid: TEST_KID,
            secretHash: `encrypted:${TEST_SECRET}`, status: "ACTIVE",
          });
        }
        return Promise.resolve(null);
      },
    );

    const jwt = createTestJwt(TEST_SECRET, TEST_KID, nonexistentAppId);
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${nonexistentAppId}/usage/events`,
      payload: [makeEvent()],
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe("App not found");
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent()],
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for missing idempotencyKey", async () => {
    const event = makeEvent();
    delete (event as Record<string, unknown>).idempotencyKey;
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [event],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for missing timestamp", async () => {
    const event = makeEvent();
    delete (event as Record<string, unknown>).timestamp;
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [event],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for missing source", async () => {
    const event = makeEvent();
    delete (event as Record<string, unknown>).source;
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [event],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects invalid eventType formats", async () => {
    const invalidTypes = [
      "UPPERCASE.v1", "no-version", "dots..double.v1",
      ".leading.dot.v1", "123numeric.v1",
    ];
    for (const eventType of invalidTypes) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/apps/${TEST_APP_ID}/usage/events`,
        payload: [makeEvent({ eventType })],
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
