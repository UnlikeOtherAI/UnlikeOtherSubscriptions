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
const TEST_USER_ID = uuidv4();
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

  mockPrisma.user.findUnique.mockImplementation(
    ({ where }: { where: Record<string, unknown> }) => {
      if (where.appId_externalRef) return Promise.resolve(null);
      if (where.id === TEST_USER_ID) {
        return Promise.resolve({
          id: TEST_USER_ID, appId: TEST_APP_ID,
          email: "test@example.com", externalRef: "ext-user-1",
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.team.findFirst.mockImplementation(
    ({ where }: { where: Record<string, unknown> }) => {
      if (where.kind === "PERSONAL" && where.ownerUserId === TEST_USER_ID) {
        return Promise.resolve({
          id: TEST_TEAM_ID, name: "Personal Team",
          kind: "PERSONAL", ownerUserId: TEST_USER_ID,
        });
      }
      return Promise.resolve(null);
    },
  );

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

describe("POST /v1/apps/:appId/usage/events — ingestion", () => {
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

  it("stores a single event correctly", async () => {
    const event = makeEvent();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [event],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(usageEvents.size).toBe(1);

    const stored = [...usageEvents.values()][0];
    expect(stored.appId).toBe(TEST_APP_ID);
    expect(stored.teamId).toBe(TEST_TEAM_ID);
    expect(stored.billToId).toBe(TEST_BILLING_ENTITY_ID);
    expect(stored.eventType).toBe("llm.tokens.v1");
    expect(stored.source).toBe("test-tool/1.0.0");
  });

  it("stores a batch of events", async () => {
    const events = [makeEvent(), makeEvent(), makeEvent()];
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: events,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(3);
    expect(body.duplicates).toBe(0);
    expect(usageEvents.size).toBe(3);
  });

  it("silently ignores duplicate idempotencyKey and counts it", async () => {
    const sharedKey = uuidv4();

    const response1 = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({ idempotencyKey: sharedKey })],
      headers: authHeaders(),
    });
    expect(response1.statusCode).toBe(200);
    expect(response1.json().accepted).toBe(1);

    const response2 = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({ idempotencyKey: sharedKey })],
      headers: authHeaders(),
    });
    expect(response2.statusCode).toBe(200);
    expect(response2.json().accepted).toBe(0);
    expect(response2.json().duplicates).toBe(1);
    expect(usageEvents.size).toBe(1);
  });

  it("resolves teamId from userId via Personal Team", async () => {
    const event = makeEvent({ teamId: undefined, userId: TEST_USER_ID });
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [event],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
    const stored = [...usageEvents.values()][0];
    expect(stored.teamId).toBe(TEST_TEAM_ID);
    expect(stored.userId).toBe(TEST_USER_ID);
  });

  it("stores the source field correctly", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({ source: "my-service/2.3.4" })],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect([...usageEvents.values()][0].source).toBe("my-service/2.3.4");
  });

  it("correctly resolves billToId from BillingEntity", async () => {
    await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent()],
      headers: authHeaders(),
    });

    expect([...usageEvents.values()][0].billToId).toBe(TEST_BILLING_ENTITY_ID);
  });

  it("handles mixed batch with new and duplicate events", async () => {
    const dupeKey = uuidv4();
    await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({ idempotencyKey: dupeKey })],
      headers: authHeaders(),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/usage/events`,
      payload: [makeEvent({ idempotencyKey: dupeKey }), makeEvent(), makeEvent()],
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(2);
    expect(body.duplicates).toBe(1);
  });

  it("accepts all registered V1 eventType formats with valid payloads", async () => {
    const typesAndPayloads: Array<{ eventType: string; payload: Record<string, unknown> }> = [
      { eventType: "llm.tokens.v1", payload: { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50 } },
      { eventType: "llm.image.v1", payload: { provider: "openai", model: "dall-e-3", width: 1024, height: 1024, count: 1 } },
      { eventType: "storage.sample.v1", payload: { bytesUsed: 1048576 } },
      { eventType: "bandwidth.sample.v1", payload: { bytesIn: 5000, bytesOut: 12000 } },
    ];
    for (const { eventType, payload } of typesAndPayloads) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/apps/${TEST_APP_ID}/usage/events`,
        payload: [makeEvent({ eventType, payload })],
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(200);
    }
  });
});
