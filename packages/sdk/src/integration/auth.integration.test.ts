import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import {
  buildEntitlementTestApp,
} from "../../../../src/routes/entitlements-test-helpers.js";
import { createBillingClient } from "../client.js";
import { BillingApiError } from "../errors.js";
import { signJwt } from "../jwt.js";
import {
  TEST_ENCRYPTION_KEY,
  TEST_SECRET,
  TEST_KID,
  TEST_APP_ID,
  TEST_TEAM_ID,
  startApp,
} from "./harness.js";

const BILLING_ENTITY_ID = uuidv4();
const REVOKED_KID = `kid_revoked_${uuidv4().replace(/-/g, "")}`;
const REVOKED_SECRET = "revoked-secret-value";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    teamSubscription: { findFirst: vi.fn() },
    contract: { findFirst: vi.fn() },
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

function setupMocks(): void {
  mockPrisma.contract.findFirst.mockResolvedValue(null);

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
      if (where.kid === REVOKED_KID) {
        return Promise.resolve({
          id: uuidv4(), appId: TEST_APP_ID, kid: REVOKED_KID,
          secretHash: `encrypted:${REVOKED_SECRET}`, status: "REVOKED",
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.jtiUsage.create.mockResolvedValue({});

  mockPrisma.team.findUnique.mockResolvedValue({
    id: TEST_TEAM_ID,
    billingMode: "SUBSCRIPTION",
    billingEntity: { id: BILLING_ENTITY_ID },
  });

  mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);
}

describe("SDK → Auth (real Fastify JWT middleware)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let closeApp: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    setupMocks();
    app = buildEntitlementTestApp();
    const started = await startApp(app);
    baseUrl = started.baseUrl;
    closeApp = started.close;
  });

  afterEach(async () => {
    await closeApp();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("succeeds with a valid JWT", async () => {
    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    const result = await client.getEntitlements(TEST_TEAM_ID);
    expect(result.billingMode).toBe("SUBSCRIPTION");
  });

  it("returns 401 BillingApiError for expired JWT", async () => {
    // Create a client that generates expired JWTs (ttl = -10 means already expired)
    const expiredToken = signJwt({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      ttlSeconds: -10,
      teamId: TEST_TEAM_ID,
    });

    // Make a raw fetch to the server with the expired token
    const url = `${baseUrl}/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/entitlements`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${expiredToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(response.status).toBe(401);
    const body = await response.json() as { message: string; statusCode: number };
    expect(body.statusCode).toBe(401);
    expect(body.message).toBe("Token expired");
  });

  it("throws BillingApiError for revoked secret (AppSecret.status = REVOKED)", async () => {
    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: REVOKED_SECRET,
      kid: REVOKED_KID,
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    try {
      await client.getEntitlements(TEST_TEAM_ID);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingApiError);
      const apiErr = err as BillingApiError;
      expect(apiErr.statusCode).toBe(401);
      expect(apiErr.message).toBe("Key has been revoked");
    }
  });

  it("throws BillingApiError with 401 for unknown kid", async () => {
    const client = createBillingClient({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: "kid_unknown_does_not_exist",
      baseUrl,
      maxRetries: 0,
      timeout: 5000,
    });

    try {
      await client.getEntitlements(TEST_TEAM_ID);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingApiError);
      const apiErr = err as BillingApiError;
      expect(apiErr.statusCode).toBe(401);
      expect(apiErr.message).toBe("Unknown key ID");
    }
  });
});
