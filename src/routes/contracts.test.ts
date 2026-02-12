import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import {
  buildContractTestApp,
  adminHeaders,
  TEST_ADMIN_API_KEY,
} from "./contracts-test-helpers.js";

const BILLING_ENTITY_ID = uuidv4();
const BUNDLE_ID = uuidv4();
const TEST_APP_ID = uuidv4();

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

describe("POST /v1/contracts", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    setupMocks();
    app = buildContractTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
  });

  it("creates a contract in DRAFT status", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: adminHeaders(),
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
      headers: adminHeaders(),
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
      headers: adminHeaders(),
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
      headers: adminHeaders(),
      payload: { billToId: "not-a-uuid" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 403 without admin API key", async () => {
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

    expect(response.statusCode).toBe(403);
  });

  it("returns 403 with invalid admin API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: { "x-admin-api-key": "wrong-key" },
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

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Invalid admin API key");
  });
});

describe("PATCH /v1/contracts/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    setupMocks();
    app = buildContractTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
  });

  it("activates a contract when no other ACTIVE contract exists", async () => {
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: adminHeaders(),
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
      headers: adminHeaders(),
      payload: { status: "ACTIVE" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ACTIVE");
  });

  it("returns 409 when activating a second contract for same billToId", async () => {
    const createResp1 = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: adminHeaders(),
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

    await app.inject({
      method: "PATCH",
      url: `/v1/contracts/${contract1Id}`,
      headers: adminHeaders(),
      payload: { status: "ACTIVE" },
    });

    const createResp2 = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: adminHeaders(),
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

    mockPrisma.contract.findFirst.mockResolvedValue({
      id: contract1Id,
      billToId: BILLING_ENTITY_ID,
      status: "ACTIVE",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/contracts/${contract2Id}`,
      headers: adminHeaders(),
      payload: { status: "ACTIVE" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("Conflict");
  });

  it("returns 404 for nonexistent contract", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/contracts/${uuidv4()}`,
      headers: adminHeaders(),
      payload: { status: "ACTIVE" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe("Contract not found");
  });

  it("updates pricingMode on a contract", async () => {
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/contracts",
      headers: adminHeaders(),
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
      headers: adminHeaders(),
      payload: { pricingMode: "MIN_COMMIT_TRUEUP" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().pricingMode).toBe("MIN_COMMIT_TRUEUP");
  });

  it("returns 403 with invalid admin API key", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/contracts/${uuidv4()}`,
      headers: { "x-admin-api-key": "wrong-key" },
      payload: { status: "ACTIVE" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Invalid admin API key");
  });
});
