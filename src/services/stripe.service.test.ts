import { describe, it, expect, vi, beforeEach } from "vitest";
import { StripeService, TeamNotFoundError } from "./stripe.service.js";

const mockTeam = {
  id: "team-1",
  name: "Acme Corp",
  kind: "STANDARD",
  ownerUserId: null,
  defaultCurrency: "USD",
  stripeCustomerId: null as string | null,
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
const mockUpdate = vi.fn();
const mockCustomersCreate = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  getPrismaClient: () => ({
    team: {
      findUnique: mockFindUnique,
      updateMany: mockUpdateMany,
      update: mockUpdate,
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
      mockUpdateMany.mockResolvedValueOnce({ count: 1 }); // claim succeeds
      mockCustomersCreate.mockResolvedValueOnce(mockCustomer);
      mockUpdate.mockResolvedValueOnce({
        ...mockTeam,
        stripeCustomerId: "cus_test123",
      });

      const result = await service.getOrCreateStripeCustomer("team-1", "app-1");

      expect(result).toBe("cus_test123");
      expect(mockCustomersCreate).toHaveBeenCalledOnce();
      expect(mockCustomersCreate).toHaveBeenCalledWith({
        name: "Acme Corp",
        metadata: { teamId: "team-1", appId: "app-1" },
      });
      // Claim was set before Stripe call
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: "team-1", stripeCustomerId: null },
        data: { stripeCustomerId: "pending:team-1" },
      });
      // Real ID was stored after Stripe call
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: "team-1" },
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
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("handles race condition where another caller claimed first", async () => {
      // First read: no stripeCustomerId
      mockFindUnique.mockResolvedValueOnce({ ...mockTeam });
      // Claim fails — someone else already claimed
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      // waitForCustomerId re-reads and finds the real ID
      mockFindUnique.mockResolvedValueOnce({
        ...mockTeam,
        stripeCustomerId: "cus_winner789",
      });

      const result = await service.getOrCreateStripeCustomer("team-1", "app-1");

      expect(result).toBe("cus_winner789");
      // Stripe was never called since we lost the claim
      expect(mockCustomersCreate).not.toHaveBeenCalled();
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
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockCustomersCreate.mockResolvedValueOnce(mockCustomer);
      mockUpdate.mockResolvedValueOnce({
        ...mockTeam,
        stripeCustomerId: "cus_test123",
      });

      await service.getOrCreateStripeCustomer("team-1", "app-1");

      const createArgs = mockCustomersCreate.mock.calls[0][0];
      expect(createArgs.metadata.teamId).toBe("team-1");
      expect(createArgs.metadata.appId).toBe("app-1");
    });

    it("uses the team name when creating the Stripe customer", async () => {
      const namedTeam = { ...mockTeam, name: "My Special Team" };
      mockFindUnique.mockResolvedValueOnce(namedTeam);
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockCustomersCreate.mockResolvedValueOnce({
        ...mockCustomer,
        name: "My Special Team",
      });
      mockUpdate.mockResolvedValueOnce({
        ...namedTeam,
        stripeCustomerId: "cus_test123",
      });

      await service.getOrCreateStripeCustomer("team-1", "app-1");

      expect(mockCustomersCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "My Special Team" }),
      );
    });

    it("propagates Stripe API errors and rolls back claim", async () => {
      mockFindUnique.mockResolvedValueOnce({ ...mockTeam });
      mockUpdateMany
        .mockResolvedValueOnce({ count: 1 }) // claim succeeds
        .mockResolvedValueOnce({ count: 1 }); // rollback succeeds
      mockCustomersCreate.mockRejectedValueOnce(
        new Error("Stripe API error"),
      );

      await expect(
        service.getOrCreateStripeCustomer("team-1", "app-1"),
      ).rejects.toThrow("Stripe API error");

      // Claim was rolled back
      expect(mockUpdateMany).toHaveBeenCalledTimes(2);
      expect(mockUpdateMany).toHaveBeenLastCalledWith({
        where: { id: "team-1", stripeCustomerId: "pending:team-1" },
        data: { stripeCustomerId: null },
      });
    });

    it("propagates unexpected database errors on claim", async () => {
      mockFindUnique.mockResolvedValueOnce({ ...mockTeam });
      mockUpdateMany.mockRejectedValueOnce(new Error("DB connection lost"));

      await expect(
        service.getOrCreateStripeCustomer("team-1", "app-1"),
      ).rejects.toThrow("DB connection lost");
    });

    it("works with teamId only (appId optional)", async () => {
      mockFindUnique.mockResolvedValueOnce({ ...mockTeam });
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockCustomersCreate.mockResolvedValueOnce({
        ...mockCustomer,
        metadata: { teamId: "team-1" },
      });
      mockUpdate.mockResolvedValueOnce({
        ...mockTeam,
        stripeCustomerId: "cus_test123",
      });

      const result = await service.getOrCreateStripeCustomer("team-1");

      expect(result).toBe("cus_test123");
      expect(mockCustomersCreate).toHaveBeenCalledWith({
        name: "Acme Corp",
        metadata: { teamId: "team-1" },
      });
    });

    it("concurrent calls: both return the same customer ID and stripe.customers.create is called once", async () => {
      // Simulate the database state as a mutable object so both calls share it
      let dbStripeCustomerId: string | null = null;

      mockFindUnique.mockImplementation(async () => {
        return { ...mockTeam, stripeCustomerId: dbStripeCustomerId };
      });

      // Only the first updateMany (claim) succeeds; the second sees non-null
      let claimTaken = false;
      mockUpdateMany.mockImplementation(async (args: { where: { stripeCustomerId: unknown }; data: { stripeCustomerId: string | null } }) => {
        if (args.where.stripeCustomerId === null && !claimTaken) {
          claimTaken = true;
          dbStripeCustomerId = args.data.stripeCustomerId;
          return { count: 1 };
        }
        // Rollback call
        if (args.data.stripeCustomerId === null) {
          dbStripeCustomerId = null;
          return { count: 1 };
        }
        return { count: 0 };
      });

      mockCustomersCreate.mockImplementation(async () => {
        // Simulate slight delay
        await new Promise((r) => setTimeout(r, 10));
        return mockCustomer;
      });

      mockUpdate.mockImplementation(async (args: { data: { stripeCustomerId: string } }) => {
        dbStripeCustomerId = args.data.stripeCustomerId;
        return { ...mockTeam, stripeCustomerId: args.data.stripeCustomerId };
      });

      // Fire two concurrent calls
      const [result1, result2] = await Promise.all([
        service.getOrCreateStripeCustomer("team-1", "app-1"),
        service.getOrCreateStripeCustomer("team-1", "app-1"),
      ]);

      // Both must return the same customer ID
      expect(result1).toBe("cus_test123");
      expect(result2).toBe("cus_test123");

      // Stripe customers.create must have been called exactly once
      expect(mockCustomersCreate).toHaveBeenCalledOnce();
    });
  });
});
