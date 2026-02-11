import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { randomBytes, createHmac } from "node:crypto";
import { registerCorrelationId } from "../middleware/correlation-id.js";
import { registerErrorHandler } from "../middleware/error-handler.js";

// --- Mocks ---

const mockConstructEvent = vi.fn();

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    stripeWebhookEvent: { create: vi.fn() },
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

vi.mock("../lib/stripe.js", () => ({
  getStripeClient: () => ({
    webhooks: { constructEvent: mockConstructEvent },
  }),
  resetStripeClient: vi.fn(),
}));

vi.mock("../lib/crypto.js", () => ({
  encryptSecret: (s: string) => `encrypted:${s}`,
  decryptSecret: (s: string) => s.replace("encrypted:", ""),
}));

// --- Test helpers ---

const WEBHOOK_URL = "/v1/stripe/webhook";
const TEST_WEBHOOK_SECRET = "whsec_test_" + randomBytes(16).toString("hex");

function makeStripeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_" + randomBytes(12).toString("hex"),
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_123" } },
    created: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function generateStripeSignature(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function buildWebhookTestApp(): Promise<FastifyInstance> {
  const { webhookRoutes } = await import("./webhook.js");
  const app = Fastify({ logger: false, requestIdHeader: false });
  registerCorrelationId(app);
  registerErrorHandler(app);
  app.register(webhookRoutes);
  return app;
}

// --- Tests ---

describe("POST /v1/stripe/webhook", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";

    // Default: constructEvent returns a valid event
    mockConstructEvent.mockImplementation(() => makeStripeEvent());

    // Default: event dedup succeeds (not a duplicate)
    mockPrisma.stripeWebhookEvent.create.mockResolvedValue({
      id: "some-uuid",
      eventId: "evt_test",
      eventType: "checkout.session.completed",
      processedAt: new Date(),
    });

    app = await buildWebhookTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("accepts a valid signature and returns 200", async () => {
    const eventPayload = JSON.stringify(makeStripeEvent());
    const sig = generateStripeSignature(eventPayload, TEST_WEBHOOK_SECRET);

    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      payload: eventPayload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sig,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.received).toBe(true);
  });

  it("stores the event in StripeWebhookEvent for deduplication", async () => {
    const event = makeStripeEvent({
      id: "evt_unique_test_123",
      type: "invoice.paid",
    });
    mockConstructEvent.mockReturnValue(event);

    const payload = JSON.stringify(event);
    const sig = generateStripeSignature(payload, TEST_WEBHOOK_SECRET);

    await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sig,
      },
    });

    expect(mockPrisma.stripeWebhookEvent.create).toHaveBeenCalledWith({
      data: {
        eventId: "evt_unique_test_123",
        eventType: "invoice.paid",
      },
    });
  });

  it("returns 400 for an invalid signature", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error(
        "No signatures found matching the expected signature for payload.",
      );
    });

    const payload = JSON.stringify(makeStripeEvent());

    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=invalid_signature",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.message).toBe("Invalid webhook signature");
  });

  it("returns 400 for missing stripe-signature header", async () => {
    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      payload: JSON.stringify(makeStripeEvent()),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.message).toBe("Missing stripe-signature header");
  });

  it("rejects duplicate event.id with 200 (idempotent)", async () => {
    const event = makeStripeEvent({ id: "evt_duplicate_123" });
    mockConstructEvent.mockReturnValue(event);

    // Simulate duplicate: Prisma unique constraint violation (P2002)
    mockPrisma.stripeWebhookEvent.create.mockRejectedValue({
      code: "P2002",
      meta: { target: ["eventId"] },
    });

    const payload = JSON.stringify(event);
    const sig = generateStripeSignature(payload, TEST_WEBHOOK_SECRET);

    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sig,
      },
    });

    // Duplicate events should return 200 (idempotent, not an error)
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.received).toBe(true);
  });

  it("acknowledges unsupported event types with 200", async () => {
    const event = makeStripeEvent({
      type: "charge.dispute.created",
    });
    mockConstructEvent.mockReturnValue(event);

    const payload = JSON.stringify(event);
    const sig = generateStripeSignature(payload, TEST_WEBHOOK_SECRET);

    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sig,
      },
    });

    // Unsupported events are acknowledged but not processed
    expect(response.statusCode).toBe(200);
    expect(response.json().received).toBe(true);
  });

  it("passes raw body to constructEvent, not JSON-parsed", async () => {
    const event = makeStripeEvent();
    const payload = JSON.stringify(event);
    const sig = generateStripeSignature(payload, TEST_WEBHOOK_SECRET);

    mockConstructEvent.mockReturnValue(event);

    await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sig,
      },
    });

    expect(mockConstructEvent).toHaveBeenCalledOnce();
    const [rawBody] = mockConstructEvent.mock.calls[0];
    // The raw body should be a Buffer, not a parsed object
    expect(Buffer.isBuffer(rawBody)).toBe(true);
    expect(rawBody.toString()).toBe(payload);
  });

  it("includes x-request-id in responses", async () => {
    const payload = JSON.stringify(makeStripeEvent());
    const sig = generateStripeSignature(payload, TEST_WEBHOOK_SECRET);

    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sig,
      },
    });

    expect(response.headers["x-request-id"]).toBeDefined();
    expect(typeof response.headers["x-request-id"]).toBe("string");
  });

  it("propagates incoming x-request-id", async () => {
    const payload = JSON.stringify(makeStripeEvent());
    const sig = generateStripeSignature(payload, TEST_WEBHOOK_SECRET);
    const customRequestId = "custom-req-id-123";

    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sig,
        "x-request-id": customRequestId,
      },
    });

    expect(response.headers["x-request-id"]).toBe(customRequestId);
  });

  it("returns 200 for each supported event type", async () => {
    const supportedTypes = [
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
      "payment_intent.succeeded",
      "payment_intent.failed",
    ];

    for (const type of supportedTypes) {
      vi.clearAllMocks();
      const event = makeStripeEvent({ id: `evt_${type}_test`, type });
      mockConstructEvent.mockReturnValue(event);
      mockPrisma.stripeWebhookEvent.create.mockResolvedValue({
        id: "uuid",
        eventId: event.id,
        eventType: type,
        processedAt: new Date(),
      });

      const payload = JSON.stringify(event);
      const sig = generateStripeSignature(payload, TEST_WEBHOOK_SECRET);

      const response = await app.inject({
        method: "POST",
        url: WEBHOOK_URL,
        payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": sig,
        },
      });

      expect(response.statusCode).toBe(200);
    }
  });
});
