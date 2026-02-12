import { PrismaClient, Prisma, PriceBookKind, UsageEvent, PriceRule, PriceBook } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";

export interface PricingResult {
  lineItems: BillableLineItemInput[];
}

export interface BillableLineItemInput {
  appId: string;
  billToId: string;
  teamId: string;
  userId: string | null;
  usageEventId: string;
  timestamp: Date;
  priceBookId: string;
  priceRuleId: string;
  amountMinor: number;
  currency: string;
  description: string;
  inputsSnapshot: Record<string, unknown>;
}

interface FlatRule {
  type: "flat";
  amount: number;
}

interface PerUnitRule {
  type: "per_unit";
  field: string;
  unitPrice: number;
}

interface TieredTier {
  upTo: number | null;
  unitPrice: number;
}

interface TieredRule {
  type: "tiered";
  field: string;
  tiers: TieredTier[];
}

type RuleConfig = FlatRule | PerUnitRule | TieredRule;

interface MatchConfig {
  eventType?: string;
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export class NoPriceBookFoundError extends Error {
  constructor(appId: string, kind: string, timestamp: Date) {
    super(
      `No ${kind} PriceBook found for app ${appId} at ${timestamp.toISOString()}`,
    );
    this.name = "NoPriceBookFoundError";
  }
}

export class NoMatchingRuleError extends Error {
  constructor(priceBookId: string, eventType: string) {
    super(
      `No matching PriceRule in PriceBook ${priceBookId} for eventType ${eventType}`,
    );
    this.name = "NoMatchingRuleError";
  }
}

export class InvalidRuleError extends Error {
  constructor(ruleId: string, reason: string) {
    super(`Invalid PriceRule ${ruleId}: ${reason}`);
    this.name = "InvalidRuleError";
  }
}

export class PricingEngine {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async priceEvent(usageEvent: UsageEvent): Promise<PricingResult> {
    const cogsBook = await this.findEffectivePriceBook(
      usageEvent.appId,
      "COGS",
      usageEvent.timestamp,
    );

    const customerBook = await this.findEffectivePriceBook(
      usageEvent.appId,
      "CUSTOMER",
      usageEvent.timestamp,
    );

    const payload = usageEvent.payload as Record<string, unknown>;

    const cogsItem = await this.computeLineItem(
      cogsBook,
      usageEvent,
      payload,
    );

    const customerItem = await this.computeLineItem(
      customerBook,
      usageEvent,
      payload,
    );

    return { lineItems: [cogsItem, customerItem] };
  }

  async persistLineItems(result: PricingResult): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const ids: string[] = [];
      for (const item of result.lineItems) {
        const created = await tx.billableLineItem.create({
          data: {
            appId: item.appId,
            billToId: item.billToId,
            teamId: item.teamId,
            userId: item.userId,
            usageEventId: item.usageEventId,
            timestamp: item.timestamp,
            priceBookId: item.priceBookId,
            priceRuleId: item.priceRuleId,
            amountMinor: item.amountMinor,
            currency: item.currency,
            description: item.description,
            inputsSnapshot: item.inputsSnapshot as Prisma.InputJsonValue,
          },
        });
        ids.push(created.id);
      }
      return ids;
    });
  }

  private async findEffectivePriceBook(
    appId: string,
    kind: PriceBookKind,
    timestamp: Date,
  ): Promise<PriceBook> {
    const book = await this.prisma.priceBook.findFirst({
      where: {
        appId,
        kind,
        effectiveFrom: { lte: timestamp },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gt: timestamp } },
        ],
      },
      orderBy: { version: "desc" },
    });

    if (!book) {
      throw new NoPriceBookFoundError(appId, kind, timestamp);
    }

    return book;
  }

  private async computeLineItem(
    priceBook: PriceBook,
    usageEvent: UsageEvent,
    payload: Record<string, unknown>,
  ): Promise<BillableLineItemInput> {
    const rules = await this.prisma.priceRule.findMany({
      where: { priceBookId: priceBook.id },
      orderBy: { priority: "desc" },
    });

    const matchedRule = this.findMatchingRule(rules, usageEvent, payload);

    if (!matchedRule) {
      throw new NoMatchingRuleError(priceBook.id, usageEvent.eventType);
    }

    const ruleConfig = matchedRule.rule as unknown as RuleConfig;
    const { amountMinor, inputsSnapshot } = this.evaluateRule(
      matchedRule.id,
      ruleConfig,
      payload,
    );

    return {
      appId: usageEvent.appId,
      billToId: usageEvent.billToId,
      teamId: usageEvent.teamId,
      userId: usageEvent.userId,
      usageEventId: usageEvent.id,
      timestamp: usageEvent.timestamp,
      priceBookId: priceBook.id,
      priceRuleId: matchedRule.id,
      amountMinor,
      currency: priceBook.currency,
      description: this.buildDescription(
        priceBook.kind,
        usageEvent.eventType,
        ruleConfig,
      ),
      inputsSnapshot,
    };
  }

  private findMatchingRule(
    rules: PriceRule[],
    usageEvent: UsageEvent,
    payload: Record<string, unknown>,
  ): PriceRule | null {
    for (const rule of rules) {
      const matchConfig = rule.match as unknown as MatchConfig;
      if (this.matchesEvent(matchConfig, usageEvent, payload)) {
        return rule;
      }
    }
    return null;
  }

  private matchesEvent(
    matchConfig: MatchConfig,
    usageEvent: UsageEvent,
    payload: Record<string, unknown>,
  ): boolean {
    for (const [key, value] of Object.entries(matchConfig)) {
      if (value === undefined || value === null) continue;
      const strValue = String(value);

      if (key === "eventType") {
        if (strValue !== "*" && strValue !== usageEvent.eventType) {
          return false;
        }
      } else {
        const payloadValue = payload[key];
        if (payloadValue === undefined || payloadValue === null) return false;
        if (strValue !== "*" && String(payloadValue) !== strValue) {
          return false;
        }
      }
    }
    return true;
  }

  evaluateRule(
    ruleId: string,
    ruleConfig: RuleConfig,
    payload: Record<string, unknown>,
  ): { amountMinor: number; inputsSnapshot: Record<string, unknown> } {
    switch (ruleConfig.type) {
      case "flat":
        return this.evaluateFlatRule(ruleConfig, payload);
      case "per_unit":
        return this.evaluatePerUnitRule(ruleId, ruleConfig, payload);
      case "tiered":
        return this.evaluateTieredRule(ruleId, ruleConfig, payload);
      default:
        throw new InvalidRuleError(
          ruleId,
          `Unsupported rule type: ${(ruleConfig as { type: string }).type}`,
        );
    }
  }

  private evaluateFlatRule(
    ruleConfig: FlatRule,
    payload: Record<string, unknown>,
  ): { amountMinor: number; inputsSnapshot: Record<string, unknown> } {
    return {
      amountMinor: Math.round(ruleConfig.amount),
      inputsSnapshot: {
        ruleType: "flat",
        amount: ruleConfig.amount,
        payload,
      },
    };
  }

  private evaluatePerUnitRule(
    ruleId: string,
    ruleConfig: PerUnitRule,
    payload: Record<string, unknown>,
  ): { amountMinor: number; inputsSnapshot: Record<string, unknown> } {
    const quantity = payload[ruleConfig.field];
    if (quantity === undefined || quantity === null) {
      throw new InvalidRuleError(
        ruleId,
        `Field "${ruleConfig.field}" not found in payload`,
      );
    }

    const numQuantity = Number(quantity);
    if (isNaN(numQuantity)) {
      throw new InvalidRuleError(
        ruleId,
        `Field "${ruleConfig.field}" is not a number: ${quantity}`,
      );
    }

    const amountMinor = Math.round(numQuantity * ruleConfig.unitPrice);

    return {
      amountMinor,
      inputsSnapshot: {
        ruleType: "per_unit",
        field: ruleConfig.field,
        quantity: numQuantity,
        unitPrice: ruleConfig.unitPrice,
        computedAmount: amountMinor,
        payload,
      },
    };
  }

  private evaluateTieredRule(
    ruleId: string,
    ruleConfig: TieredRule,
    payload: Record<string, unknown>,
  ): { amountMinor: number; inputsSnapshot: Record<string, unknown> } {
    const quantity = payload[ruleConfig.field];
    if (quantity === undefined || quantity === null) {
      throw new InvalidRuleError(
        ruleId,
        `Field "${ruleConfig.field}" not found in payload`,
      );
    }

    const numQuantity = Number(quantity);
    if (isNaN(numQuantity)) {
      throw new InvalidRuleError(
        ruleId,
        `Field "${ruleConfig.field}" is not a number: ${quantity}`,
      );
    }

    let remaining = numQuantity;
    let total = 0;
    const tierBreakdown: Array<{
      from: number;
      to: number;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }> = [];
    let prevUpTo = 0;

    for (const tier of ruleConfig.tiers) {
      if (remaining <= 0) break;

      const tierCapacity =
        tier.upTo === null ? remaining : tier.upTo - prevUpTo;
      const tierQuantity = Math.min(remaining, tierCapacity);

      const subtotal = Math.round(tierQuantity * tier.unitPrice);
      total += subtotal;

      tierBreakdown.push({
        from: prevUpTo,
        to: tier.upTo === null ? prevUpTo + tierQuantity : tier.upTo,
        quantity: tierQuantity,
        unitPrice: tier.unitPrice,
        subtotal,
      });

      remaining -= tierQuantity;
      prevUpTo = tier.upTo ?? prevUpTo + tierQuantity;
    }

    return {
      amountMinor: total,
      inputsSnapshot: {
        ruleType: "tiered",
        field: ruleConfig.field,
        quantity: numQuantity,
        tiers: tierBreakdown,
        computedAmount: total,
        payload,
      },
    };
  }

  private buildDescription(
    kind: PriceBookKind,
    eventType: string,
    ruleConfig: RuleConfig,
  ): string {
    const kindLabel = kind === "COGS" ? "COGS" : "Customer";
    return `${kindLabel} pricing: ${eventType} (${ruleConfig.type})`;
  }
}
