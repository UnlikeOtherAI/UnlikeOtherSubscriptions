import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { createTestJwt, buildTeamTestApp } from "./teams-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();

// In-memory stores for mock data
let teams: Map<string, Record<string, unknown>>;
let billingEntities: Map<string, Record<string, unknown>>;
let externalTeamRefs: Map<string, Record<string, unknown>>;

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: { findUnique: vi.fn() },
    team: { create: vi.fn(), findUnique: vi.fn() },
    billingEntity: { create: vi.fn() },
    externalTeamRef: { findUnique: vi.fn(), create: vi.fn() },
    appSecret: { findUnique: vi.fn() },
    jtiUsage: { create: vi.fn() },
    $transaction: vi.fn(),
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
    "Unique constraint failed on the fields: (`appId`,`externalTeamId`)",
    { code: "P2002", clientVersion: "6.3.1", meta: { target: ["appId", "externalTeamId"] } },
  );
}

function setupMocks(): void {
  // App lookup
  mockPrisma.app.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
    if (where.id === TEST_APP_ID) {
      return Promise.resolve({ id: TEST_APP_ID, name: "Test App", status: "ACTIVE" });
    }
    return Promise.resolve(null);
  });

  // AppSecret lookup for JWT auth
  mockPrisma.appSecret.findUnique.mockImplementation(({ where }: { where: { kid: string } }) => {
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
  });

  // JTI usage for replay protection
  mockPrisma.jtiUsage.create.mockResolvedValue({});

  // ExternalTeamRef findUnique — check in-memory store
  mockPrisma.externalTeamRef.findUnique.mockImplementation(
    ({ where, include }: { where: Record<string, unknown>; include?: Record<string, unknown> }) => {
      if (where.appId_externalTeamId) {
        const key = where.appId_externalTeamId as { appId: string; externalTeamId: string };
        const compositeKey = `${key.appId}:${key.externalTeamId}`;
        const ref = externalTeamRefs.get(compositeKey);
        if (ref && include?.billingTeam) {
          const team = teams.get(ref.billingTeamId as string);
          const be = [...billingEntities.values()].find(
            (b) => b.teamId === ref.billingTeamId,
          );
          return Promise.resolve({
            ...ref,
            billingTeam: { ...team, billingEntity: be ?? null },
          });
        }
        return Promise.resolve(ref ?? null);
      }
      return Promise.resolve(null);
    },
  );

  // Transaction mock
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      const tx = {
        team: {
          create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            const id = uuidv4();
            const record = {
              id,
              ...data,
              defaultCurrency: "USD",
              stripeCustomerId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            teams.set(id, record);
            return Promise.resolve(record);
          }),
        },
        billingEntity: {
          create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            const id = uuidv4();
            const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
            billingEntities.set(id, record);
            return Promise.resolve(record);
          }),
        },
        externalTeamRef: {
          create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            const compositeKey = `${data.appId}:${data.externalTeamId}`;
            if (externalTeamRefs.has(compositeKey)) {
              throw makeP2002Error();
            }
            const id = uuidv4();
            const record = { id, ...data, createdAt: new Date() };
            externalTeamRefs.set(compositeKey, record);
            return Promise.resolve(record);
          }),
        },
      };
      return fn(tx as unknown as typeof mockPrisma);
    },
  );
}

function authHeaders(appIdOverride?: string): Record<string, string> {
  const jwt = createTestJwt(TEST_SECRET, TEST_KID, appIdOverride ?? TEST_APP_ID);
  return { authorization: `Bearer ${jwt}` };
}

describe("POST /v1/apps/:appId/teams", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    teams = new Map();
    billingEntities = new Map();
    externalTeamRefs = new Map();

    setupMocks();

    app = buildTeamTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("creates a Team with kind=STANDARD and returns teamId", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams`,
      payload: { name: "My Team" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.team).toBeDefined();
    expect(body.team.id).toBeDefined();
    expect(body.team.name).toBe("My Team");
    expect(body.team.kind).toBe("STANDARD");
    expect(body.team.billingMode).toBe("SUBSCRIPTION");
    expect(body.team.defaultCurrency).toBe("USD");
    expect(body.team.stripeCustomerId).toBeNull();
    expect(body.billingEntityId).toBeDefined();
  });

  it("auto-creates a BillingEntity with type=TEAM", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams`,
      payload: { name: "My Team" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);

    expect(billingEntities.size).toBe(1);
    const be = [...billingEntities.values()][0];
    expect(be.type).toBe("TEAM");

    const body = response.json();
    expect(be.teamId).toBe(body.team.id);
    expect(body.billingEntityId).toBe(be.id);
  });

  it("creates ExternalTeamRef when externalTeamId is provided", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams`,
      payload: { name: "External Team", externalTeamId: "ext-team-abc" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.externalTeamRefId).toBeDefined();
    expect(externalTeamRefs.size).toBe(1);

    const ref = [...externalTeamRefs.values()][0];
    expect(ref.appId).toBe(TEST_APP_ID);
    expect(ref.externalTeamId).toBe("ext-team-abc");
    expect(ref.billingTeamId).toBe(body.team.id);
  });

  it("is idempotent — duplicate externalTeamId returns existing Team", async () => {
    // First call: create team with externalTeamId
    const response1 = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams`,
      payload: { name: "External Team", externalTeamId: "ext-team-dup" },
      headers: authHeaders(),
    });

    expect(response1.statusCode).toBe(200);
    const body1 = response1.json();

    // Second call: same externalTeamId — should return existing team
    const response2 = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams`,
      payload: { name: "External Team Again", externalTeamId: "ext-team-dup" },
      headers: authHeaders(),
    });

    expect(response2.statusCode).toBe(200);
    const body2 = response2.json();

    // Same team ID returned
    expect(body2.team.id).toBe(body1.team.id);
    expect(body2.billingEntityId).toBe(body1.billingEntityId);
    expect(body2.externalTeamRefId).toBe(body1.externalTeamRefId);

    // Only one team was created
    expect(teams.size).toBe(1);
    expect(externalTeamRefs.size).toBe(1);
  });

  it("handles concurrent creation with same externalTeamId via P2002 recovery", async () => {
    // Simulate race: first call succeeds, second hits P2002 in transaction
    // Override transaction to simulate P2002 on the second call
    let callCount = 0;
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        callCount++;
        const tx = {
          team: {
            create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
              const id = uuidv4();
              const record = {
                id,
                ...data,
                defaultCurrency: "USD",
                stripeCustomerId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              teams.set(id, record);
              return Promise.resolve(record);
            }),
          },
          billingEntity: {
            create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
              const id = uuidv4();
              const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
              billingEntities.set(id, record);
              return Promise.resolve(record);
            }),
          },
          externalTeamRef: {
            create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
              const compositeKey = `${data.appId}:${data.externalTeamId}`;
              if (externalTeamRefs.has(compositeKey)) {
                throw makeP2002Error();
              }
              const id = uuidv4();
              const record = { id, ...data, createdAt: new Date() };
              externalTeamRefs.set(compositeKey, record);
              return Promise.resolve(record);
            }),
          },
        };
        return fn(tx as unknown as typeof mockPrisma);
      },
    );

    const [response1, response2] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/apps/${TEST_APP_ID}/teams`,
        payload: { name: "Race Team", externalTeamId: "ext-race" },
        headers: authHeaders(),
      }),
      app.inject({
        method: "POST",
        url: `/v1/apps/${TEST_APP_ID}/teams`,
        payload: { name: "Race Team", externalTeamId: "ext-race" },
        headers: authHeaders(),
      }),
    ]);

    expect(response1.statusCode).toBe(200);
    expect(response2.statusCode).toBe(200);

    const body1 = response1.json();
    const body2 = response2.json();

    // Both return the same team ID
    expect(body1.team.id).toBe(body2.team.id);
  });

  it("returns 404 when App does not exist", async () => {
    const nonexistentAppId = uuidv4();

    // Override appSecret to return a secret for the nonexistent app so JWT passes
    mockPrisma.appSecret.findUnique.mockImplementation(({ where }: { where: { kid: string } }) => {
      if (where.kid === TEST_KID) {
        return Promise.resolve({
          id: uuidv4(),
          appId: nonexistentAppId,
          kid: TEST_KID,
          secretHash: `encrypted:${TEST_SECRET}`,
          status: "ACTIVE",
        });
      }
      return Promise.resolve(null);
    });

    const jwt = createTestJwt(TEST_SECRET, TEST_KID, nonexistentAppId);
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${nonexistentAppId}/teams`,
      payload: { name: "Ghost Team" },
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("App not found");
  });

  it("returns 403 when JWT appId does not match route appId", async () => {
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${differentAppId}/teams`,
      payload: { name: "Forbidden Team" },
      headers: authHeaders(), // JWT has TEST_APP_ID
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toBe("JWT appId does not match route appId");
  });

  it("returns 400 for missing name", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams`,
      payload: {},
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for empty name", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams`,
      payload: { name: "" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams`,
      payload: { name: "My Team" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("does not create ExternalTeamRef when externalTeamId is not provided", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams`,
      payload: { name: "Simple Team" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.externalTeamRefId).toBeUndefined();
    expect(externalTeamRefs.size).toBe(0);
  });
});
