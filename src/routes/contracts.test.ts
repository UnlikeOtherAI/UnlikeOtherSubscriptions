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
const BILLING_ENTITY_ID = uuidv4();
const BUNDLE_ID = uuidv4();

const contracts = new Map<string, Record<string, unknown>>();
const overrides = new Map<string, Array<Record<string, unknown>>>();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    billingEntity: { findUnique: vi.fn() },
    bundle: { findUnique: vi.fn() },
    contract: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    contractOverride: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
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
  contracts.clear();
  overrides.clear();

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

  mockPrisma.billingEntity.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === BILLING_ENTITY_ID) {
        return Promise.resolve({
          id: BILLING_ENTITY_ID,
          type: "TEAM",
          teamId: uuidv4(),
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.bundle.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === BUNDLE_ID) {
        return Promise.resolve({
          id: BUNDLE_ID,
          code: "enterprise_all",
          name: "Enterprise All Apps",
          status: "ACTIVE",
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.contract.create.mockImplementation(
    ({ data, include }: { data: Record<string, unknown>; include?: unknown }) => {
      const id = uuidv4();
      const record = {
        id,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(include ? {
          bundle: { id: BUNDLE_ID, code: "enterprise_all", name: "Enterprise All Apps", status: "ACTIVE" },
          overrides: [],
        } : {}),
      };
      contracts.set(id, record);
      overrides.set(id, []);
      return Promise.resolve(record);
    },
  );

  mockPrisma.contract.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      const contract = contracts.get(where.id);
      if (!contract) return Promise.resolve(null);
      return Promise.resolve({
        ...contract,
        billingEntity: {
          id: BILLING_ENTITY_ID,
          type: "TEAM",
          teamId: uuidv4(),
          team: { id: uuidv4(), name: "Test Team" },
        },
      });
    },
  );

  mockPrisma.contract.findFirst.mockResolvedValue(null);

  mockPrisma.contract.update.mockImplementation(
    ({ where, data, include }: { where: { id: string }; data: Record<string, unknown>; include?: unknown }) => {
      const existing = contracts.get(where.id);
      if (!existing) return Promise.reject(new Error("Not found"));
      const updated = {
        ...existing,
        ...data,
        updatedAt: new Date(),
        ...(include ? {
          bundle: { id: BUNDLE_ID, code: "enterprise_all", name: "Enterprise All Apps", status: "ACTIVE" },
          overrides: overrides.get(where.id) ?? [],
        } : {}),
      };
      contracts.set(where.id, updated);
      return Promise.resolve(updated);
    },
  );

  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn(mockPrisma);
    },
  );

  mockPrisma.contractOverride.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.contractOverride.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.contractOverride.findMany.mockImplementation(
    ({ where }: { where: { contractId: string } }) => {
      return Promise.resolve(overrides.get(where.contractId) ?? []);
    },
  );
}

function authHeaders(): Record<string, string> {
  const jwt = createTestJwt(TEST_SECRET, TEST_KID, TEST_APP_ID);
  return { authorization: `Bearer ${jwt}` };
}

describe("POST /v1/contracts", () => {
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

  it("creates a contract in DRAFT status", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.status).toBe("DRAFT");
    expect(body.billToId).toBe(BILLING_ENTITY_ID);
    expect(body.bundleId).toBe(BUNDLE_ID);
  });

  it("returns 404 for nonexistent billToId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: uuidv4(),
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe("BillingEntity not found");
  });

  it("returns 404 for nonexistent bundleId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: uuidv4(),
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe("Bundle not found");
  });

  it("returns 400 for invalid payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: { billToId: "not-a-uuid" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("PATCH /v1/contracts/:id", () => {
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

  it("activates a contract when no other ACTIVE contract exists", async () => {
    // Create a contract first
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const contractId = createResp.json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/contracts/${contractId}`,
      headers: authHeaders(),
      payload: { status: "ACTIVE" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ACTIVE");
  });

  it("returns 409 when activating a second contract for same billToId", async () => {
    // Create and activate the first contract
    const createResp1 = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const contract1Id = createResp1.json().id;

    // Activate the first
    await app.inject({
      method: "PATCH",
      url: `/v1/contracts/${contract1Id}`,
      headers: authHeaders(),
      payload: { status: "ACTIVE" },
    });

    // Create second contract
    const createResp2 = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "QUARTERLY",
        termsDays: 60,
        pricingMode: "FIXED_PLUS_TRUEUP",
        startsAt: "2025-06-01T00:00:00.000Z",
      },
    });
    const contract2Id = createResp2.json().id;

    // Mock: the first contract is already ACTIVE
    mockPrisma.contract.findFirst.mockResolvedValue({
      id: contract1Id,
      billToId: BILLING_ENTITY_ID,
      status: "ACTIVE",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/contracts/${contract2Id}`,
      headers: authHeaders(),
      payload: { status: "ACTIVE" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("Conflict");
  });

  it("returns 404 for nonexistent contract", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/contracts/${uuidv4()}`,
      headers: authHeaders(),
      payload: { status: "ACTIVE" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe("Contract not found");
  });

  it("updates pricingMode on a contract", async () => {
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const contractId = createResp.json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/contracts/${contractId}`,
      headers: authHeaders(),
      payload: { pricingMode: "MIN_COMMIT_TRUEUP" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().pricingMode).toBe("MIN_COMMIT_TRUEUP");
  });
});

describe("PUT /v1/contracts/:id/overrides", () => {
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

  it("replaces all overrides for a contract", async () => {
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const contractId = createResp.json().id;

    const overrideData = [
      {
        appId: TEST_APP_ID,
        meterKey: "llm.tokens.in",
        limitType: "INCLUDED" as const,
        includedAmount: 5000000,
        enforcement: "HARD" as const,
        overageBilling: "PER_UNIT" as const,
      },
    ];

    // Mock: return the newly created overrides
    mockPrisma.contractOverride.findMany.mockResolvedValue(
      overrideData.map((o) => ({
        id: uuidv4(),
        contractId,
        ...o,
        featureFlags: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );

    const response = await app.inject({
      method: "PUT",
      url: `/v1/contracts/${contractId}/overrides`,
      headers: authHeaders(),
      payload: overrideData,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].meterKey).toBe("llm.tokens.in");
    expect(body[0].limitType).toBe("INCLUDED");
  });

  it("returns 404 for nonexistent contract", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/v1/contracts/${uuidv4()}/overrides`,
      headers: authHeaders(),
      payload: [],
    });

    expect(response.statusCode).toBe(404);
  });

  it("clears all overrides when empty array provided", async () => {
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const contractId = createResp.json().id;

    mockPrisma.contractOverride.findMany.mockResolvedValue([]);

    const response = await app.inject({
      method: "PUT",
      url: `/v1/contracts/${contractId}/overrides`,
      headers: authHeaders(),
      payload: [],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(mockPrisma.contractOverride.deleteMany).toHaveBeenCalledWith({
      where: { contractId },
    });
  });

  it("returns 400 for invalid override data", async () => {
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: authHeaders(),
      payload: {
        billToId: BILLING_ENTITY_ID,
        bundleId: BUNDLE_ID,
        currency: "USD",
        billingPeriod: "MONTHLY",
        termsDays: 30,
        pricingMode: "FIXED",
        startsAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const contractId = createResp.json().id;

    const response = await app.inject({
      method: "PUT",
      url: `/v1/contracts/${contractId}/overrides`,
      headers: authHeaders(),
      payload: [{ appId: "not-a-uuid", meterKey: "" }],
    });

    expect(response.statusCode).toBe(400);
  });
});
