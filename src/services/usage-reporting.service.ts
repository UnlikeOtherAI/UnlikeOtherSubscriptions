import { getPrismaClient } from "../lib/prisma.js";
import { Prisma, PriceBookKind } from "@prisma/client";

export type UsageGroupBy = "app" | "meter" | "provider" | "model";

export interface UsageReportFilter {
  from: Date;
  to: Date;
  groupBy: UsageGroupBy;
}

export interface CogsReportFilter {
  from: Date;
  to: Date;
}

export interface UsageGroupResult {
  groupKey: string;
  cogsAmountMinor: number;
  customerAmountMinor: number;
  count: number;
}

export interface UsageReportResult {
  groups: UsageGroupResult[];
  from: string;
  to: string;
  groupBy: UsageGroupBy;
}

export interface CogsGroupResult {
  app: string;
  meter: string;
  amountMinor: number;
  count: number;
}

export interface CogsReportResult {
  groups: CogsGroupResult[];
  from: string;
  to: string;
}

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}

export class BillingEntityNotFoundError extends Error {
  constructor(teamId: string) {
    super(`No billing entity found for team: ${teamId}`);
    this.name = "BillingEntityNotFoundError";
  }
}

export class UsageReportingService {
  async resolveTeamBillToId(teamId: string): Promise<string> {
    const prisma = getPrismaClient();

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { billingEntity: true },
    });

    if (!team) {
      throw new TeamNotFoundError(teamId);
    }

    if (!team.billingEntity) {
      throw new BillingEntityNotFoundError(teamId);
    }

    return team.billingEntity.id;
  }

  async getUsageReport(
    teamId: string,
    filter: UsageReportFilter,
  ): Promise<UsageReportResult> {
    const billToId = await this.resolveTeamBillToId(teamId);
    const prisma = getPrismaClient();

    const lineItems = await prisma.billableLineItem.findMany({
      where: {
        billToId,
        timestamp: {
          gte: filter.from,
          lte: filter.to,
        },
      },
      include: {
        priceBook: { select: { kind: true } },
      },
    });

    // For meter/provider/model grouping, we need UsageEvent data
    let usageEventMap: Map<string, { eventType: string; payload: Record<string, unknown> }> | undefined;

    if (filter.groupBy !== "app") {
      const usageEventIds = lineItems
        .map((li) => li.usageEventId)
        .filter((id): id is string => id !== null);

      if (usageEventIds.length > 0) {
        const uniqueIds = [...new Set(usageEventIds)];
        const usageEvents = await prisma.usageEvent.findMany({
          where: { id: { in: uniqueIds } },
          select: { id: true, eventType: true, payload: true },
        });

        usageEventMap = new Map(
          usageEvents.map((ue) => [
            ue.id,
            {
              eventType: ue.eventType,
              payload: ue.payload as Record<string, unknown>,
            },
          ]),
        );
      }
    }

    const groups = this.aggregateByGroup(
      lineItems,
      filter.groupBy,
      usageEventMap,
    );

    return {
      groups,
      from: filter.from.toISOString(),
      to: filter.to.toISOString(),
      groupBy: filter.groupBy,
    };
  }

  async getCogsReport(
    teamId: string,
    filter: CogsReportFilter,
  ): Promise<CogsReportResult> {
    const billToId = await this.resolveTeamBillToId(teamId);
    const prisma = getPrismaClient();

    const lineItems = await prisma.billableLineItem.findMany({
      where: {
        billToId,
        timestamp: {
          gte: filter.from,
          lte: filter.to,
        },
        priceBook: { kind: PriceBookKind.COGS },
      },
      include: {
        priceBook: { select: { kind: true } },
      },
    });

    // Fetch usage events for meter grouping
    const usageEventIds = lineItems
      .map((li) => li.usageEventId)
      .filter((id): id is string => id !== null);

    let usageEventMap = new Map<
      string,
      { eventType: string }
    >();

    if (usageEventIds.length > 0) {
      const uniqueIds = [...new Set(usageEventIds)];
      const usageEvents = await prisma.usageEvent.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true, eventType: true },
      });

      usageEventMap = new Map(
        usageEvents.map((ue) => [ue.id, { eventType: ue.eventType }]),
      );
    }

    const cogsGroups = this.aggregateCogsbyAppAndMeter(
      lineItems,
      usageEventMap,
    );

    return {
      groups: cogsGroups,
      from: filter.from.toISOString(),
      to: filter.to.toISOString(),
    };
  }

  private aggregateByGroup(
    lineItems: Array<{
      id: string;
      appId: string;
      usageEventId: string | null;
      amountMinor: number;
      priceBook: { kind: PriceBookKind };
    }>,
    groupBy: UsageGroupBy,
    usageEventMap?: Map<string, { eventType: string; payload: Record<string, unknown> }>,
  ): UsageGroupResult[] {
    const groupMap = new Map<
      string,
      { cogsAmountMinor: number; customerAmountMinor: number; count: number }
    >();

    for (const li of lineItems) {
      const key = this.getGroupKey(li, groupBy, usageEventMap);
      if (key === null) continue;

      const existing = groupMap.get(key) ?? {
        cogsAmountMinor: 0,
        customerAmountMinor: 0,
        count: 0,
      };

      if (li.priceBook.kind === PriceBookKind.COGS) {
        existing.cogsAmountMinor += li.amountMinor;
      } else {
        existing.customerAmountMinor += li.amountMinor;
      }
      existing.count += 1;

      groupMap.set(key, existing);
    }

    return Array.from(groupMap.entries()).map(([groupKey, data]) => ({
      groupKey,
      cogsAmountMinor: data.cogsAmountMinor,
      customerAmountMinor: data.customerAmountMinor,
      count: data.count,
    }));
  }

  private getGroupKey(
    lineItem: {
      appId: string;
      usageEventId: string | null;
    },
    groupBy: UsageGroupBy,
    usageEventMap?: Map<string, { eventType: string; payload: Record<string, unknown> }>,
  ): string | null {
    switch (groupBy) {
      case "app":
        return lineItem.appId;

      case "meter": {
        if (!lineItem.usageEventId || !usageEventMap) return "unknown";
        const event = usageEventMap.get(lineItem.usageEventId);
        return event?.eventType ?? "unknown";
      }

      case "provider": {
        if (!lineItem.usageEventId || !usageEventMap) return "unknown";
        const event = usageEventMap.get(lineItem.usageEventId);
        const provider = event?.payload?.provider;
        return typeof provider === "string" ? provider : "unknown";
      }

      case "model": {
        if (!lineItem.usageEventId || !usageEventMap) return "unknown";
        const event = usageEventMap.get(lineItem.usageEventId);
        const model = event?.payload?.model;
        return typeof model === "string" ? model : "unknown";
      }

      default:
        return null;
    }
  }

  private aggregateCogsbyAppAndMeter(
    lineItems: Array<{
      id: string;
      appId: string;
      usageEventId: string | null;
      amountMinor: number;
    }>,
    usageEventMap: Map<string, { eventType: string }>,
  ): CogsGroupResult[] {
    const groupMap = new Map<
      string,
      { app: string; meter: string; amountMinor: number; count: number }
    >();

    for (const li of lineItems) {
      const meter = li.usageEventId
        ? (usageEventMap.get(li.usageEventId)?.eventType ?? "unknown")
        : "unknown";

      const key = `${li.appId}:${meter}`;
      const existing = groupMap.get(key) ?? {
        app: li.appId,
        meter,
        amountMinor: 0,
        count: 0,
      };

      existing.amountMinor += li.amountMinor;
      existing.count += 1;
      groupMap.set(key, existing);
    }

    return Array.from(groupMap.values());
  }
}
