import { describe, it, expect, vi, beforeEach } from "vitest";
import { StripeService, TeamNotFoundError } from "./stripe.service.js";

const mockTeam = {
  id: "team-1",
  name: "Acme Corp",
  kind: "STANDARD",
  ownerUserId: null,
  defaultCurrency: "USD",
  stripeCustomerId: null,
  billingMode: "SUBSCRIPTION",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockCustomer = {
  id: "cus_test123",
  object: "customer" as const,
  name: "Acme Corp",
  metadata: { teamId: "team-1", appId: "app-1" },
};

const mockFindUnique = vi.fn();
const mockUpdateMany = vi.fn();
const mockCustomersCreate = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => ({
    team: {
      findUnique: mockFindUnique,
      updateMany: mockUpdateMany,
    },
  }),
}));

vi.mock("../lib/stripe.js", () => ({
  getStripeClient: () => ({
    customers: {
      create: mockCustomersCreate,
    },
  }),
}));

describe("StripeService", () => {
  let service: StripeService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new StripeService();
  });

  describe("getOrCreateStripeCustomer", () => {
    it("creates a Stripe customer and stores the ID on the Team on first call", async () => {
      mockFindUnique.mockResolvedValueOnce({ ...mockTeam });
      mockCustomersCreate.mockResolvedValueOnce(mockCustomer);
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.getOrCreateStripeCustomer("team-1", "app-1");

      expect(result).toBe("cus_test123");
      expect(mockCustomersCreate).toHaveBeenCalledOnce();
      expect(mockCustomersCreate).toHaveBeenCalledWith({
        name: "Acme Corp",
        metadata: { teamId: "team-1", appId: "app-1" },
      });
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: "team-1", stripeCustomerId: null },
        data: { stripeCustomerId: "cus_test123" },
      });
    });

    it("returns existing customer ID without calling Stripe when already set", async () => {
      mockFindUnique.mockResolvedValueOnce({
        ...mockTeam,
        stripeCustomerId: "cus_existing456",
      });

      const result = await service.getOrCreateStripeCustomer("team-1", "app-1");

      expect(result).toBe("cus_existing456");
      expect(mockCustomersCreate).not.toHaveBeenCalled();
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it("handles race condition where another caller already set stripeCustomerId", async () => {
      // First read: no stripeCustomerId
      mockFindUnique.mockResolvedValueOnce({ ...mockTeam });
      mockCustomersCreate.mockResolvedValueOnce(mockCustomer);
      // updateMany returns 0 — someone else won the race
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      // Re-fetch returns the winner's customer ID
      mockFindUnique.mockResolvedValueOnce({
        ...mockTeam,
        stripeCustomerId: "cus_winner789",
      });

      const result = await service.getOrCreateStripeCustomer("team-1", "app-1");

      expect(result).toBe("cus_winner789");
      expect(mockCustomersCreate).toHaveBeenCalledOnce();
      // updateMany was called but affected 0 rows
      expect(mockUpdateMany).toHaveBeenCalledOnce();
      // Second findUnique to read the winner's value
      expect(mockFindUnique).toHaveBeenCalledTimes(2);
    });

    it("throws TeamNotFoundError for nonexistent team", async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(
        service.getOrCreateStripeCustomer("nonexistent-team", "app-1"),
      ).rejects.toThrow(TeamNotFoundError);

      expect(mockCustomersCreate).not.toHaveBeenCalled();
    });

    it("includes teamId in the Stripe customer metadata", async () => {
      mockFindUnique.mockResolvedValueOnce({ ...mockTeam });
      mockCustomersCreate.mockResolvedValueOnce(mockCustomer);
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      await service.getOrCreateStripeCustomer("team-1", "app-1");

      const createArgs = mockCustomersCreate.mock.calls[0][0];
      expect(createArgs.metadata.teamId).toBe("team-1");
      expect(createArgs.metadata.appId).toBe("app-1");
    });

    it("uses the team name when creating the Stripe customer", async () => {
      const namedTeam = { ...mockTeam, name: "My Special Team" };
      mockFindUnique.mockResolvedValueOnce(namedTeam);
      mockCustomersCreate.mockResolvedValueOnce({
        ...mockCustomer,
        name: "My Special Team",
      });
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      await service.getOrCreateStripeCustomer("team-1", "app-1");

      expect(mockCustomersCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "My Special Team" }),
      );
    });

    it("propagates Stripe API errors", async () => {
      mockFindUnique.mockResolvedValueOnce({ ...mockTeam });
      mockCustomersCreate.mockRejectedValueOnce(
        new Error("Stripe API error"),
      );

      await expect(
        service.getOrCreateStripeCustomer("team-1", "app-1"),
      ).rejects.toThrow("Stripe API error");
    });

    it("propagates unexpected database errors", async () => {
      mockFindUnique.mockResolvedValueOnce({ ...mockTeam });
      mockCustomersCreate.mockResolvedValueOnce(mockCustomer);
      mockUpdateMany.mockRejectedValueOnce(new Error("DB connection lost"));

      await expect(
        service.getOrCreateStripeCustomer("team-1", "app-1"),
      ).rejects.toThrow("DB connection lost");
    });
  });
});
