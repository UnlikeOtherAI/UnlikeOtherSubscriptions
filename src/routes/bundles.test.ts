import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  createTestJwt,
  buildContractTestApp,
} from "./contracts-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();

const bundles = new Map<string, Record<string, unknown>>();
const bundleApps = new Map<string, Array<Record<string, unknown>>>();
const bundlePolicies = new Map<string, Array<Record<string, unknown>>>();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    bundle: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    bundleApp: { createMany: vi.fn(), deleteMany: vi.fn() },
    bundleMeterPolicy: { createMany: vi.fn(), deleteMany: vi.fn() },
    contract: { findMany: vi.fn() },
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

function setupMocks(): void {
  bundles.clear();
  bundleApps.clear();
  bundlePolicies.clear();

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

  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn(mockPrisma);
    },
  );

  mockPrisma.bundle.create.mockImplementation(
    ({ data }: { data: { code: string; name: string } }) => {
      // Check for duplicate code
      for (const b of bundles.values()) {
        if (b.code === data.code) {
          const err = new Error("Unique constraint failed") as Error & { code: string };
          err.code = "P2002";
          return Promise.reject(err);
        }
      }
      const id = uuidv4();
      const record = {
        id,
        code: data.code,
        name: data.name,
        status: "ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      bundles.set(id, record);
      bundleApps.set(id, []);
      bundlePolicies.set(id, []);
      return Promise.resolve(record);
    },
  );

  mockPrisma.bundle.findUnique.mockImplementation(
    ({ where, include }: { where: { id: string }; include?: unknown }) => {
      const bundle = bundles.get(where.id);
      if (!bundle) return Promise.resolve(null);
      if (include) {
        return Promise.resolve({
          ...bundle,
          apps: bundleApps.get(where.id) ?? [],
          meterPolicies: bundlePolicies.get(where.id) ?? [],
        });
      }
      return Promise.resolve(bundle);
    },
  );

  mockPrisma.bundle.update.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const existing = bundles.get(where.id);
      if (!existing) return Promise.reject(new Error("Not found"));
      const updated = { ...existing, ...data, updatedAt: new Date() };
      bundles.set(where.id, updated);
      return Promise.resolve(updated);
    },
  );

  mockPrisma.bundleApp.createMany.mockImplementation(
    ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const item of data) {
        const bundleId = item.bundleId as string;
        const existing = bundleApps.get(bundleId) ?? [];
        existing.push({ id: uuidv4(), ...item, createdAt: new Date(), updatedAt: new Date() });
        bundleApps.set(bundleId, existing);
      }
      return Promise.resolve({ count: data.length });
    },
  );

  mockPrisma.bundleApp.deleteMany.mockImplementation(
    ({ where }: { where: { bundleId: string } }) => {
      bundleApps.set(where.bundleId, []);
      return Promise.resolve({ count: 0 });
    },
  );

  mockPrisma.bundleMeterPolicy.createMany.mockImplementation(
    ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const item of data) {
        const bundleId = item.bundleId as string;
        const existing = bundlePolicies.get(bundleId) ?? [];
        existing.push({ id: uuidv4(), ...item, createdAt: new Date(), updatedAt: new Date() });
        bundlePolicies.set(bundleId, existing);
      }
      return Promise.resolve({ count: data.length });
    },
  );

  mockPrisma.bundleMeterPolicy.deleteMany.mockImplementation(
    ({ where }: { where: { bundleId: string } }) => {
      bundlePolicies.set(where.bundleId, []);
      return Promise.resolve({ count: 0 });
    },
  );

  mockPrisma.contract.findMany.mockResolvedValue([]);
}

function authHeaders(): Record<string, string> {
  const jwt = createTestJwt(TEST_SECRET, TEST_KID, TEST_APP_ID);
  return { authorization: `Bearer ${jwt}` };
}

describe("POST /v1/bundles", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    setupMocks();
    app = buildContractTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("creates a bundle with apps and meter policies", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeaders(),
      payload: {
        code: "enterprise_all",
        name: "Enterprise All Apps",
        apps: [
          { appId: TEST_APP_ID, defaultFeatureFlags: { analytics: true } },
        ],
        meterPolicies: [
          {
            appId: TEST_APP_ID,
            meterKey: "llm.tokens.in",
            limitType: "INCLUDED",
            includedAmount: 1000000,
            enforcement: "SOFT",
            overageBilling: "PER_UNIT",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.code).toBe("enterprise_all");
    expect(body.name).toBe("Enterprise All Apps");
    expect(body.apps.length).toBe(1);
    expect(body.apps[0].appId).toBe(TEST_APP_ID);
    expect(body.meterPolicies.length).toBe(1);
    expect(body.meterPolicies[0].meterKey).toBe("llm.tokens.in");
  });

  it("creates a bundle without apps or policies", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeaders(),
      payload: {
        code: "basic_bundle",
        name: "Basic Bundle",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.code).toBe("basic_bundle");
    expect(body.apps).toEqual([]);
    expect(body.meterPolicies).toEqual([]);
  });

  it("returns 409 for duplicate bundle code", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeaders(),
      payload: {
        code: "duplicate_code",
        name: "First Bundle",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeaders(),
      payload: {
        code: "duplicate_code",
        name: "Second Bundle",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("Conflict");
  });

  it("returns 400 for missing required fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeaders(),
      payload: { name: "No Code" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      payload: {
        code: "test",
        name: "Test",
      },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("PATCH /v1/bundles/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    setupMocks();
    app = buildContractTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("updates bundle apps", async () => {
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeaders(),
      payload: {
        code: "updatable_bundle",
        name: "Updatable Bundle",
        apps: [{ appId: TEST_APP_ID }],
      },
    });
    const bundleId = createResp.json().id;

    const newAppId = uuidv4();
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/bundles/${bundleId}`,
      headers: authHeaders(),
      payload: {
        apps: [
          { appId: TEST_APP_ID },
          { appId: newAppId, defaultFeatureFlags: { beta: true } },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.apps.length).toBe(2);
  });

  it("updates bundle meter policies", async () => {
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeaders(),
      payload: {
        code: "policy_update_bundle",
        name: "Policy Update Bundle",
      },
    });
    const bundleId = createResp.json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/bundles/${bundleId}`,
      headers: authHeaders(),
      payload: {
        meterPolicies: [
          {
            appId: TEST_APP_ID,
            meterKey: "storage.bytes",
            limitType: "HARD_CAP",
            includedAmount: 10000,
            enforcement: "HARD",
            overageBilling: "TIERED",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meterPolicies.length).toBe(1);
    expect(body.meterPolicies[0].meterKey).toBe("storage.bytes");
  });

  it("returns 404 for nonexistent bundle", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/bundles/${uuidv4()}`,
      headers: authHeaders(),
      payload: { name: "Updated" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe("Bundle not found");
  });

  it("updates bundle name", async () => {
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeaders(),
      payload: {
        code: "rename_bundle",
        name: "Original Name",
      },
    });
    const bundleId = createResp.json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/bundles/${bundleId}`,
      headers: authHeaders(),
      payload: { name: "Updated Name" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe("Updated Name");
  });
});
