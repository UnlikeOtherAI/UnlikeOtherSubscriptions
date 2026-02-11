import { describe, it, expect, vi, beforeEach } from "vitest";
import { v4 as uuidv4 } from "uuid";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    team: { findUnique: vi.fn() },
    teamSubscription: { findFirst: vi.fn() },
  },
}));

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

import {
  EntitlementService,
  TeamNotFoundError,
} from "./entitlement.service.js";

describe("EntitlementService", () => {
  let service: EntitlementService;

  const APP_ID = uuidv4();
  const TEAM_ID = uuidv4();
  const PLAN_ID = uuidv4();
  const BILLING_ENTITY_ID = uuidv4();

  beforeEach(() => {
    vi.clearAllMocks();
    service = new EntitlementService();
  });

  describe("resolveEntitlements", () => {
    it("throws TeamNotFoundError for nonexistent team", async () => {
      mockPrisma.team.findUnique.mockResolvedValue(null);

      await expect(
        service.resolveEntitlements(APP_ID, TEAM_ID),
      ).rejects.toThrow(TeamNotFoundError);
    });

    it("returns default entitlements for team with no subscription", async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEAM_ID,
        billingMode: "SUBSCRIPTION",
        billingEntity: { id: BILLING_ENTITY_ID },
      });
      mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

      const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

      expect(result.billingMode).toBe("SUBSCRIPTION");
      expect(result.billable).toBe(false);
      expect(result.planCode).toBeNull();
      expect(result.planName).toBeNull();
      expect(result.features).toEqual({});
      expect(result.meters).toEqual({});
    });

    it("returns plan entitlements for team with active subscription", async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEAM_ID,
        billingMode: "SUBSCRIPTION",
        billingEntity: { id: BILLING_ENTITY_ID },
      });
      mockPrisma.teamSubscription.findFirst.mockResolvedValue({
        id: uuidv4(),
        teamId: TEAM_ID,
        status: "ACTIVE",
        planId: PLAN_ID,
        plan: {
          id: PLAN_ID,
          appId: APP_ID,
          code: "pro",
          name: "Pro Plan",
          status: "ACTIVE",
        },
      });

      const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

      expect(result.billingMode).toBe("SUBSCRIPTION");
      expect(result.billable).toBe(true);
      expect(result.planCode).toBe("pro");
      expect(result.planName).toBe("Pro Plan");
    });

    it("returns default entitlements for team with cancelled subscription", async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEAM_ID,
        billingMode: "SUBSCRIPTION",
        billingEntity: { id: BILLING_ENTITY_ID },
      });
      // Cancelled subscriptions won't match the status: "ACTIVE" filter
      mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

      const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

      expect(result.billable).toBe(false);
      expect(result.planCode).toBeNull();
    });

    it("reflects the team billingMode in the result", async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEAM_ID,
        billingMode: "WALLET",
        billingEntity: { id: BILLING_ENTITY_ID },
      });
      mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

      const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

      expect(result.billingMode).toBe("WALLET");
    });

    it("queries subscription filtered by appId via plan relation", async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEAM_ID,
        billingMode: "SUBSCRIPTION",
        billingEntity: { id: BILLING_ENTITY_ID },
      });
      mockPrisma.teamSubscription.findFirst.mockResolvedValue(null);

      await service.resolveEntitlements(APP_ID, TEAM_ID);

      expect(mockPrisma.teamSubscription.findFirst).toHaveBeenCalledWith({
        where: {
          teamId: TEAM_ID,
          status: "ACTIVE",
          plan: { appId: APP_ID },
        },
        include: { plan: true },
      });
    });

    it("returns HYBRID billingMode correctly", async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: TEAM_ID,
        billingMode: "HYBRID",
        billingEntity: { id: BILLING_ENTITY_ID },
      });
      mockPrisma.teamSubscription.findFirst.mockResolvedValue({
        id: uuidv4(),
        teamId: TEAM_ID,
        status: "ACTIVE",
        planId: PLAN_ID,
        plan: {
          id: PLAN_ID,
          appId: APP_ID,
          code: "enterprise",
          name: "Enterprise",
          status: "ACTIVE",
        },
      });

      const result = await service.resolveEntitlements(APP_ID, TEAM_ID);

      expect(result.billingMode).toBe("HYBRID");
      expect(result.billable).toBe(true);
    });
  });

  describe("refreshEntitlements", () => {
    it("resolves without error (no-op in V1)", async () => {
      await expect(
        service.refreshEntitlements(TEAM_ID),
      ).resolves.toBeUndefined();
    });
  });
});
