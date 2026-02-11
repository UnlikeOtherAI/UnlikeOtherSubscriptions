import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  createTestJwt,
  buildTeamMemberTestApp,
} from "./team-members-test-helpers.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const TEST_SECRET = randomBytes(32).toString("hex");
const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
const TEST_APP_ID = uuidv4();
const TEST_TEAM_ID = uuidv4();
const TEST_USER_ID = uuidv4();

let teamMembers: Map<string, Record<string, unknown>>;

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    app: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    teamMember: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
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
  mockPrisma.app.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === TEST_APP_ID) {
        return Promise.resolve({
          id: TEST_APP_ID,
          name: "Test App",
          status: "ACTIVE",
        });
      }
      return Promise.resolve(null);
    },
  );

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

  mockPrisma.team.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === TEST_TEAM_ID) {
        return Promise.resolve({
          id: TEST_TEAM_ID,
          name: "Test Team",
          kind: "STANDARD",
          billingMode: "SUBSCRIPTION",
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.user.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === TEST_USER_ID) {
        return Promise.resolve({
          id: TEST_USER_ID,
          appId: TEST_APP_ID,
          email: "test@example.com",
          externalRef: "ext-user-1",
        });
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.teamMember.findUnique.mockImplementation(
    ({
      where,
    }: {
      where: { teamId_userId?: { teamId: string; userId: string } };
    }) => {
      if (where.teamId_userId) {
        const key = `${where.teamId_userId.teamId}:${where.teamId_userId.userId}`;
        return Promise.resolve(teamMembers.get(key) ?? null);
      }
      return Promise.resolve(null);
    },
  );

  mockPrisma.teamMember.create.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) => {
      const key = `${data.teamId}:${data.userId}`;
      if (teamMembers.has(key)) {
        throw new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed",
          {
            code: "P2002",
            clientVersion: "6.3.1",
            meta: { target: ["teamId", "userId"] },
          },
        );
      }
      const id = uuidv4();
      const record = {
        id,
        ...data,
        status: "ACTIVE",
        startedAt: new Date(),
        endedAt: null,
      };
      teamMembers.set(key, record);
      return Promise.resolve(record);
    },
  );

  mockPrisma.teamMember.update.mockImplementation(
    ({
      where,
      data,
    }: {
      where: { teamId_userId: { teamId: string; userId: string } };
      data: Record<string, unknown>;
    }) => {
      const key = `${where.teamId_userId.teamId}:${where.teamId_userId.userId}`;
      const existing = teamMembers.get(key);
      if (!existing) return Promise.resolve(null);
      const updated = { ...existing, ...data };
      teamMembers.set(key, updated);
      return Promise.resolve(updated);
    },
  );

  mockPrisma.teamMember.count.mockImplementation(
    ({ where }: { where: { teamId: string; status: string } }) => {
      let count = 0;
      for (const member of teamMembers.values()) {
        if (member.teamId === where.teamId && member.status === where.status) {
          count++;
        }
      }
      return Promise.resolve(count);
    },
  );
}

function authHeaders(appIdOverride?: string): Record<string, string> {
  const jwt = createTestJwt(
    TEST_SECRET,
    TEST_KID,
    appIdOverride ?? TEST_APP_ID,
  );
  return { authorization: `Bearer ${jwt}` };
}

describe("POST /v1/apps/:appId/teams/:teamId/users", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    teamMembers = new Map();
    setupMocks();
    app = buildTeamMemberTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("creates a TeamMember with status=ACTIVE", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: TEST_USER_ID },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.member).toBeDefined();
    expect(body.member.id).toBeDefined();
    expect(body.member.teamId).toBe(TEST_TEAM_ID);
    expect(body.member.userId).toBe(TEST_USER_ID);
    expect(body.member.role).toBe("MEMBER");
    expect(body.member.status).toBe("ACTIVE");
    expect(body.member.startedAt).toBeDefined();
    expect(body.member.endedAt).toBeNull();
  });

  it("creates a TeamMember with a specified role", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: TEST_USER_ID, role: "ADMIN" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.member.role).toBe("ADMIN");
  });

  it("is idempotent — adding same user again returns existing membership", async () => {
    const response1 = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: TEST_USER_ID },
      headers: authHeaders(),
    });

    expect(response1.statusCode).toBe(200);
    const body1 = response1.json();

    const response2 = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: TEST_USER_ID },
      headers: authHeaders(),
    });

    expect(response2.statusCode).toBe(200);
    const body2 = response2.json();

    expect(body2.member.id).toBe(body1.member.id);
    expect(teamMembers.size).toBe(1);
  });

  it("returns 404 when team does not exist", async () => {
    const fakeTeamId = uuidv4();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${fakeTeamId}/users`,
      payload: { userId: TEST_USER_ID },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("Team not found");
  });

  it("returns 404 when user does not exist", async () => {
    const fakeUserId = uuidv4();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: fakeUserId },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("User not found");
  });

  it("returns 403 when JWT appId does not match route appId", async () => {
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${differentAppId}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: TEST_USER_ID },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toBe("JWT appId does not match route appId");
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: TEST_USER_ID },
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for missing userId", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: {},
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for invalid role", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: TEST_USER_ID, role: "SUPERADMIN" },
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("reactivates a REMOVED membership on re-add with ACTIVE status and increased seat count", async () => {
    // Step 1: Add the member initially
    const addResponse = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: TEST_USER_ID },
      headers: authHeaders(),
    });
    expect(addResponse.statusCode).toBe(200);
    expect(addResponse.json().member.status).toBe("ACTIVE");

    // Verify active seat count is 1
    const countAfterAdd = await mockPrisma.teamMember.count({
      where: { teamId: TEST_TEAM_ID, status: "ACTIVE" },
    });
    expect(countAfterAdd).toBe(1);

    // Step 2: Remove the member (simulate soft delete)
    const key = `${TEST_TEAM_ID}:${TEST_USER_ID}`;
    const existing = teamMembers.get(key)!;
    teamMembers.set(key, {
      ...existing,
      status: "REMOVED",
      endedAt: new Date("2025-06-01"),
    });

    // Verify active seat count dropped to 0
    const countAfterRemove = await mockPrisma.teamMember.count({
      where: { teamId: TEST_TEAM_ID, status: "ACTIVE" },
    });
    expect(countAfterRemove).toBe(0);

    // Step 3: Re-add the same user via POST endpoint
    const readdResponse = await app.inject({
      method: "POST",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users`,
      payload: { userId: TEST_USER_ID },
      headers: authHeaders(),
    });

    expect(readdResponse.statusCode).toBe(200);
    const readdBody = readdResponse.json();
    expect(readdBody.member.status).toBe("ACTIVE");
    expect(readdBody.member.endedAt).toBeNull();

    // Step 4: Verify active seat count increased back to 1
    const countAfterReadd = await mockPrisma.teamMember.count({
      where: { teamId: TEST_TEAM_ID, status: "ACTIVE" },
    });
    expect(countAfterReadd).toBe(1);
  });
});
