import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import {
  buildUsageEventTestApp,
} from "../../../../src/routes/usage-events-test-helpers.js";
import { createBillingClient } from "../client.js";
import { BillingApiError } from "../errors.js";
import {
  TEST_ENCRYPTION_KEY,
  TEST_SECRET,
  TEST_KID,
  TEST_APP_ID,
  TEST_TEAM_ID,
  startApp,
} from "./harness.js";

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

vi.mock("../../../../src/lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../../../../src/lib/pg-boss.js", () => ({ stopBoss: vi.fn() }));

vi.mock("../../../../src/lib/crypto.js", () => ({
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

describe("SDK → Usage Events (real Fastify stack)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let closeApp: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    usageEvents = new Map();
    setupMocks();
    app = buildUsageEventTestApp();
    const started = await startApp(app);
    baseUrl = started.baseUrl;
    closeApp = started.close;
  });

  afterEach(async () => {
    await closeApp();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("sends usage events via SDK and receives accepted count", async () => {
    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    const result = await client.reportUsage([
      {
        idempotencyKey: uuidv4(),
        eventType: "llm.tokens.v1",
        timestamp: new Date().toISOString(),
        teamId: TEST_TEAM_ID,
        payload: { provider: "openai", model: "gpt-5", inputTokens: 200, outputTokens: 100 },
        source: "sdk-integration/1.0.0",
      },
      {
        idempotencyKey: uuidv4(),
        eventType: "llm.tokens.v1",
        timestamp: new Date().toISOString(),
        teamId: TEST_TEAM_ID,
        payload: { provider: "openai", model: "gpt-5", inputTokens: 50, outputTokens: 25 },
        source: "sdk-integration/1.0.0",
      },
    ]);

    expect(result.accepted).toBe(2);
    expect(result.duplicates).toBe(0);
  });

  it("handles duplicate idempotencyKey correctly", async () => {
    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    const sharedKey = uuidv4();
    const event = {
      idempotencyKey: sharedKey,
      eventType: "llm.tokens.v1",
      timestamp: new Date().toISOString(),
      teamId: TEST_TEAM_ID,
      payload: { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50 },
      source: "sdk-integration/1.0.0",
    };

    const first = await client.reportUsage([event]);
    expect(first.accepted).toBe(1);

    const second = await client.reportUsage([event]);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(1);
  });

  it("reports multiple event types in a batch", async () => {
    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    const result = await client.reportUsage([
      {
        idempotencyKey: uuidv4(),
        eventType: "llm.tokens.v1",
        timestamp: new Date().toISOString(),
        teamId: TEST_TEAM_ID,
        payload: { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50 },
        source: "sdk-integration/1.0.0",
      },
      {
        idempotencyKey: uuidv4(),
        eventType: "llm.image.v1",
        timestamp: new Date().toISOString(),
        teamId: TEST_TEAM_ID,
        payload: { provider: "openai", model: "dall-e-3", width: 1024, height: 1024, count: 1 },
        source: "sdk-integration/1.0.0",
      },
    ]);

    expect(result.accepted).toBe(2);
    expect(result.duplicates).toBe(0);
  });
});
