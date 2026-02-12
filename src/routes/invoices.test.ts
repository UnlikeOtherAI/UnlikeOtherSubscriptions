import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import {
  TEST_ADMIN_API_KEY,
  adminHeaders,
  buildInvoiceTestApp,
} from "./invoices-test-helpers.js";

const TEST_TEAM_ID = uuidv4();
const BILLING_ENTITY_ID = uuidv4();
const TEST_APP_ID = uuidv4();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    team: { findUnique: vi.fn() },
    invoice: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    invoiceLineItem: { create: vi.fn(), findFirst: vi.fn() },
    billableLineItem: { findMany: vi.fn() },
    ledgerAccount: { findUnique: vi.fn(), create: vi.fn() },
    ledgerEntry: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    appSecret: { findUnique: vi.fn() },
    jtiUsage: { create: vi.fn() },
    $transaction: vi.fn(),
    $executeRawUnsafe: vi.fn(),
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

function setupMocks() {
  mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
    return fn(mockPrisma);
  });
  mockPrisma.auditLog.create.mockResolvedValue({ id: uuidv4() });
}

describe("POST /v1/invoices/generate", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    setupMocks();
    app = buildInvoiceTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
  });

  it("generates an invoice with correct line items and totals", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });

    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    mockPrisma.billableLineItem.findMany.mockResolvedValue([
      {
        id: uuidv4(),
        appId: TEST_APP_ID,
        amountMinor: 5000,
        inputsSnapshot: { eventType: "llm.tokens.v1" },
        priceBook: { kind: "CUSTOMER" },
      },
      {
        id: uuidv4(),
        appId: TEST_APP_ID,
        amountMinor: 3000,
        inputsSnapshot: { eventType: "llm.tokens.v1" },
        priceBook: { kind: "CUSTOMER" },
      },
    ]);

    const invoiceId = uuidv4();
    mockPrisma.invoice.create.mockResolvedValue({
      id: invoiceId,
      billToId: BILLING_ENTITY_ID,
      contractId: null,
      periodStart: new Date("2025-01-01T00:00:00.000Z"),
      periodEnd: new Date("2025-02-01T00:00:00.000Z"),
      status: "ISSUED",
      subtotalMinor: 8000,
      taxMinor: 0,
      totalMinor: 8000,
      issuedAt: new Date(),
    });

    mockPrisma.invoiceLineItem.create.mockResolvedValue({});

    const response = await app.inject({
      method: "POST",
      url: "/v1/invoices/generate",
      headers: adminHeaders(),
      payload: {
        teamId: TEST_TEAM_ID,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-02-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe(invoiceId);
    expect(body.billToId).toBe(BILLING_ENTITY_ID);
    expect(body.status).toBe("ISSUED");
    expect(body.subtotalMinor).toBe(8000);
    expect(body.totalMinor).toBe(8000);
    expect(body.lineItemCount).toBe(1);
  });

  it("creates audit log entry on successful generation", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });

    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.billableLineItem.findMany.mockResolvedValue([]);

    const invoiceId = uuidv4();
    mockPrisma.invoice.create.mockResolvedValue({
      id: invoiceId,
      billToId: BILLING_ENTITY_ID,
      contractId: null,
      periodStart: new Date("2025-01-01T00:00:00.000Z"),
      periodEnd: new Date("2025-02-01T00:00:00.000Z"),
      status: "ISSUED",
      subtotalMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
      issuedAt: new Date(),
    });

    mockPrisma.invoiceLineItem.create.mockResolvedValue({});

    const response = await app.inject({
      method: "POST",
      url: "/v1/invoices/generate",
      headers: adminHeaders(),
      payload: {
        teamId: TEST_TEAM_ID,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-02-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.action).toBe("invoice.generate");
    expect(auditCall.data.entityType).toBe("Invoice");
    expect(auditCall.data.entityId).toBe(invoiceId);
    expect(auditCall.data.actor).toBe("admin");
  });

  it("returns 404 for nonexistent team", async () => {
    mockPrisma.team.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: "/v1/invoices/generate",
      headers: adminHeaders(),
      payload: {
        teamId: uuidv4(),
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-02-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("Not Found");
  });

  it("returns 404 for team without billing entity", async () => {
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: null,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/invoices/generate",
      headers: adminHeaders(),
      payload: {
        teamId: TEST_TEAM_ID,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-02-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for invalid payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/invoices/generate",
      headers: adminHeaders(),
      payload: { teamId: "not-a-uuid" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 403 without admin API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/invoices/generate",
      payload: {
        teamId: TEST_TEAM_ID,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-02-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns existing invoice for same team+period (idempotent)", async () => {
    const existingId = uuidv4();
    mockPrisma.team.findUnique.mockResolvedValue({
      id: TEST_TEAM_ID,
      billingEntity: { id: BILLING_ENTITY_ID },
    });

    mockPrisma.invoice.findFirst.mockResolvedValue({
      id: existingId,
      billToId: BILLING_ENTITY_ID,
      contractId: null,
      periodStart: new Date("2025-01-01T00:00:00.000Z"),
      periodEnd: new Date("2025-02-01T00:00:00.000Z"),
      status: "ISSUED",
      subtotalMinor: 5000,
      taxMinor: 0,
      totalMinor: 5000,
      lineItems: [{ id: uuidv4() }],
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/invoices/generate",
      headers: adminHeaders(),
      payload: {
        teamId: TEST_TEAM_ID,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-02-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().id).toBe(existingId);
  });
});

describe("GET /v1/invoices/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    setupMocks();
    app = buildInvoiceTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
  });

  it("returns full invoice with line items", async () => {
    const invoiceId = uuidv4();
    const lineItemId = uuidv4();

    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: invoiceId,
      billToId: BILLING_ENTITY_ID,
      contractId: null,
      periodStart: new Date("2025-01-01T00:00:00.000Z"),
      periodEnd: new Date("2025-02-01T00:00:00.000Z"),
      status: "ISSUED",
      subtotalMinor: 5000,
      taxMinor: 0,
      totalMinor: 5000,
      externalRef: null,
      issuedAt: new Date("2025-02-01T00:00:00.000Z"),
      dueAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lineItems: [
        {
          id: lineItemId,
          invoiceId,
          appId: TEST_APP_ID,
          type: "USAGE_TRUEUP",
          description: "Usage: llm.tokens.v1",
          quantity: 2,
          unitPriceMinor: 2500,
          amountMinor: 5000,
          usageSummary: { meterKey: "llm.tokens.v1" },
          createdAt: new Date(),
        },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(invoiceId);
    expect(body.lineItems).toHaveLength(1);
    expect(body.lineItems[0].type).toBe("USAGE_TRUEUP");
    expect(body.lineItems[0].amountMinor).toBe(5000);
  });

  it("creates audit log entry on successful view", async () => {
    const invoiceId = uuidv4();

    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: invoiceId,
      billToId: BILLING_ENTITY_ID,
      contractId: null,
      periodStart: new Date("2025-01-01T00:00:00.000Z"),
      periodEnd: new Date("2025-02-01T00:00:00.000Z"),
      status: "ISSUED",
      subtotalMinor: 5000,
      taxMinor: 0,
      totalMinor: 5000,
      externalRef: null,
      issuedAt: new Date(),
      dueAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lineItems: [],
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.action).toBe("invoice.view");
    expect(auditCall.data.entityType).toBe("Invoice");
    expect(auditCall.data.entityId).toBe(invoiceId);
    expect(auditCall.data.actor).toBe("admin");
  });

  it("returns 404 for nonexistent invoice", async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: `/v1/invoices/${uuidv4()}`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("Not Found");
  });

  it("returns 403 without admin API key", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/invoices/${uuidv4()}`,
    });

    expect(response.statusCode).toBe(403);
  });
});
