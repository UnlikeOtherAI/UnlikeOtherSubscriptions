import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import {
  TEST_ADMIN_API_KEY,
  adminHeaders,
  buildInvoiceTestApp,
} from "./invoices-test-helpers.js";

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

describe("POST /v1/invoices/:id/export", () => {
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

  it("returns structured JSON export", async () => {
    const invoiceId = uuidv4();
    const lineItemId = uuidv4();
    const issuedAt = new Date("2025-02-01T00:00:00.000Z");
    const createdAt = new Date("2025-01-31T00:00:00.000Z");

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
      issuedAt,
      dueAt: null,
      createdAt,
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
      method: "POST",
      url: `/v1/invoices/${invoiceId}/export`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.invoice).toBeDefined();
    expect(body.invoice.id).toBe(invoiceId);
    expect(body.invoice.periodStart).toBe("2025-01-01T00:00:00.000Z");
    expect(body.invoice.periodEnd).toBe("2025-02-01T00:00:00.000Z");
    expect(body.invoice.issuedAt).toBe(issuedAt.toISOString());
    expect(body.invoice.createdAt).toBe(createdAt.toISOString());
    expect(body.lineItems).toHaveLength(1);
    expect(body.lineItems[0].id).toBe(lineItemId);
    expect(body.lineItems[0].type).toBe("USAGE_TRUEUP");
  });

  it("creates audit log entry on successful export", async () => {
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
      method: "POST",
      url: `/v1/invoices/${invoiceId}/export`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.action).toBe("invoice.export");
    expect(auditCall.data.entityType).toBe("Invoice");
    expect(auditCall.data.entityId).toBe(invoiceId);
    expect(auditCall.data.actor).toBe("admin");
  });

  it("returns 404 for nonexistent invoice", async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: `/v1/invoices/${uuidv4()}/export`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /v1/invoices/:id/mark-paid", () => {
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

  it("transitions status from ISSUED to PAID and creates ledger entry", async () => {
    const invoiceId = uuidv4();

    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: invoiceId,
      billToId: BILLING_ENTITY_ID,
      status: "ISSUED",
      totalMinor: 5000,
    });

    mockPrisma.invoice.update.mockResolvedValue({
      id: invoiceId,
      status: "PAID",
    });

    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue({
      appId: TEST_APP_ID,
    });

    mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
      id: uuidv4(),
      appId: TEST_APP_ID,
      billToId: BILLING_ENTITY_ID,
      type: "ACCOUNTS_RECEIVABLE",
    });

    mockPrisma.ledgerEntry.create.mockResolvedValue({
      id: uuidv4(),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/mark-paid`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(invoiceId);
    expect(body.status).toBe("PAID");
  });

  it("creates audit log entry on successful mark-paid", async () => {
    const invoiceId = uuidv4();

    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: invoiceId,
      billToId: BILLING_ENTITY_ID,
      status: "ISSUED",
      totalMinor: 5000,
    });

    mockPrisma.invoice.update.mockResolvedValue({
      id: invoiceId,
      status: "PAID",
    });

    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue({
      appId: TEST_APP_ID,
    });

    mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
      id: uuidv4(),
      appId: TEST_APP_ID,
      billToId: BILLING_ENTITY_ID,
      type: "ACCOUNTS_RECEIVABLE",
    });

    mockPrisma.ledgerEntry.create.mockResolvedValue({
      id: uuidv4(),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/mark-paid`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.action).toBe("invoice.mark-paid");
    expect(auditCall.data.entityType).toBe("Invoice");
    expect(auditCall.data.entityId).toBe(invoiceId);
    expect(auditCall.data.actor).toBe("admin");
  });

  it("rolls back status update when ledger entry creation fails", async () => {
    const invoiceId = uuidv4();

    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: invoiceId,
      billToId: BILLING_ENTITY_ID,
      status: "ISSUED",
      totalMinor: 5000,
    });

    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue({
      appId: TEST_APP_ID,
    });

    mockPrisma.ledgerAccount.findUnique.mockResolvedValue({
      id: uuidv4(),
      appId: TEST_APP_ID,
      billToId: BILLING_ENTITY_ID,
      type: "ACCOUNTS_RECEIVABLE",
    });

    // Simulate the transaction throwing when ledger entry creation fails
    // The $transaction mock should throw the same error the ledger create throws
    const ledgerError = new Error("Database connection lost");
    mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
      // Create a mock tx that lets update succeed but ledgerEntry.create fails
      const txMock = {
        ...mockPrisma,
        invoice: {
          ...mockPrisma.invoice,
          update: vi.fn().mockResolvedValue({
            id: invoiceId,
            status: "PAID",
          }),
        },
        ledgerEntry: {
          create: vi.fn().mockRejectedValue(ledgerError),
        },
        $executeRawUnsafe: vi.fn(),
      };
      return fn(txMock);
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/mark-paid`,
      headers: adminHeaders(),
    });

    // The request should fail with 500 because the transaction rolled back
    expect(response.statusCode).toBe(500);

    // The invoice.update on the real prisma should NOT have been called
    // (the update happened inside the transaction which rolled back)
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it("returns 400 for non-ISSUED invoice (e.g. DRAFT)", async () => {
    const invoiceId = uuidv4();

    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: invoiceId,
      billToId: BILLING_ENTITY_ID,
      status: "DRAFT",
      totalMinor: 5000,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/mark-paid`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Bad Request");
  });

  it("is idempotent when invoice is already PAID", async () => {
    const invoiceId = uuidv4();

    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: invoiceId,
      billToId: BILLING_ENTITY_ID,
      status: "PAID",
      totalMinor: 5000,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/mark-paid`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("PAID");
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it("returns 404 for nonexistent invoice", async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: `/v1/invoices/${uuidv4()}/mark-paid`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 403 without admin API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/invoices/${uuidv4()}/mark-paid`,
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 403 with invalid admin API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/invoices/${uuidv4()}/mark-paid`,
      headers: { "x-admin-api-key": "wrong-key" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Invalid admin API key");
  });
});
