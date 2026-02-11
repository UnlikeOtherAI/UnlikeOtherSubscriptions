import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
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

function seedMember(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const member = {
    id: uuidv4(),
    teamId: TEST_TEAM_ID,
    userId: TEST_USER_ID,
    role: "MEMBER",
    status: "ACTIVE",
    startedAt: new Date(),
    endedAt: null,
    ...overrides,
  };
  const key = `${member.teamId}:${member.userId}`;
  teamMembers.set(key, member);
  return member;
}

describe("DELETE /v1/apps/:appId/teams/:teamId/users/:userId", () => {
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

  it("sets status to REMOVED and endedAt on removal", async () => {
    seedMember();

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users/${TEST_USER_ID}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.member.status).toBe("REMOVED");
    expect(body.member.endedAt).toBeDefined();
    expect(body.member.endedAt).not.toBeNull();
  });

  it("preserves seat history after removal (soft delete)", async () => {
    seedMember();

    await app.inject({
      method: "DELETE",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users/${TEST_USER_ID}`,
      headers: authHeaders(),
    });

    // The record is still in the store (soft delete), just with REMOVED status
    const key = `${TEST_TEAM_ID}:${TEST_USER_ID}`;
    const record = teamMembers.get(key);
    expect(record).toBeDefined();
    expect(record!.status).toBe("REMOVED");
    expect(record!.endedAt).not.toBeNull();
    expect(record!.startedAt).toBeDefined();
  });

  it("active seat count reflects additions and removals", async () => {
    // Add a member
    seedMember();
    expect(teamMembers.size).toBe(1);

    // Count active members before removal
    const countBefore = await mockPrisma.teamMember.count({
      where: { teamId: TEST_TEAM_ID, status: "ACTIVE" },
    });
    expect(countBefore).toBe(1);

    // Remove the member
    await app.inject({
      method: "DELETE",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users/${TEST_USER_ID}`,
      headers: authHeaders(),
    });

    // Count active members after removal
    const countAfter = await mockPrisma.teamMember.count({
      where: { teamId: TEST_TEAM_ID, status: "ACTIVE" },
    });
    expect(countAfter).toBe(0);
  });

  it("returns 404 when team does not exist", async () => {
    const fakeTeamId = uuidv4();
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/apps/${TEST_APP_ID}/teams/${fakeTeamId}/users/${TEST_USER_ID}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("Team not found");
  });

  it("returns 404 when member does not exist", async () => {
    const fakeUserId = uuidv4();
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users/${fakeUserId}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toBe("Member not found");
  });

  it("returns 403 when JWT appId does not match route appId", async () => {
    seedMember();
    const differentAppId = uuidv4();
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/apps/${differentAppId}/teams/${TEST_TEAM_ID}/users/${TEST_USER_ID}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toBe("JWT appId does not match route appId");
  });

  it("returns 401 without authorization header", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users/${TEST_USER_ID}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("is idempotent — removing already-removed member returns same result", async () => {
    seedMember({ status: "REMOVED", endedAt: new Date("2025-01-01") });

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/apps/${TEST_APP_ID}/teams/${TEST_TEAM_ID}/users/${TEST_USER_ID}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.member.status).toBe("REMOVED");
  });
});
