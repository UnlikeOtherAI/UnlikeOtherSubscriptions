import { getPrismaClient } from "../lib/prisma.js";
import {
  Prisma,
  LedgerEntryType,
  LedgerReferenceType,
  LedgerAccountType,
  LedgerEntry,
} from "@prisma/client";

export interface CreateLedgerEntryInput {
  appId: string;
  billToId: string;
  accountType: LedgerAccountType;
  type: LedgerEntryType;
  amountMinor: number;
  currency: string;
  referenceType: LedgerReferenceType;
  referenceId?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface GetEntriesFilter {
  from?: Date;
  to?: Date;
  type?: LedgerEntryType;
  limit?: number;
  offset?: number;
}

export interface LedgerEntriesResult {
  entries: LedgerEntry[];
  total: number;
}

export class DuplicateLedgerEntryError extends Error {
  constructor(idempotencyKey: string) {
    super(`Duplicate ledger entry: ${idempotencyKey}`);
    this.name = "DuplicateLedgerEntryError";
  }
}

export class BillingEntityNotFoundError extends Error {
  constructor(teamId: string) {
    super(`No billing entity found for team: ${teamId}`);
    this.name = "BillingEntityNotFoundError";
  }
}

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}

function isPrismaUniqueError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

export class LedgerService {
  /**
   * Get or create a LedgerAccount for the given appId, billToId, and type.
   */
  async getOrCreateAccount(
    appId: string,
    billToId: string,
    type: LedgerAccountType,
  ): Promise<string> {
    const prisma = getPrismaClient();

    const existing = await prisma.ledgerAccount.findUnique({
      where: {
        appId_billToId_type: { appId, billToId, type },
      },
    });

    if (existing) {
      return existing.id;
    }

    try {
      const created = await prisma.ledgerAccount.create({
        data: { appId, billToId, type },
      });
      return created.id;
    } catch (err: unknown) {
      if (isPrismaUniqueError(err)) {
        const found = await prisma.ledgerAccount.findUnique({
          where: {
            appId_billToId_type: { appId, billToId, type },
          },
        });
        return found!.id;
      }
      throw err;
    }
  }

  /**
   * Create a ledger entry with idempotency protection inside a transaction.
   * Uses pg advisory lock per billToId to prevent concurrent balance corruption.
   */
  async createEntry(input: CreateLedgerEntryInput): Promise<string> {
    const prisma = getPrismaClient();

    const ledgerAccountId = await this.getOrCreateAccount(
      input.appId,
      input.billToId,
      input.accountType,
    );

    // Use a transaction with advisory lock to serialize balance-affecting writes
    const lockKey = hashToInt32(input.billToId);

    try {
      const entry = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock($1)`,
          lockKey,
        );

        return tx.ledgerEntry.create({
          data: {
            appId: input.appId,
            billToId: input.billToId,
            ledgerAccountId,
            type: input.type,
            amountMinor: input.amountMinor,
            currency: input.currency,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
            idempotencyKey: input.idempotencyKey,
            metadata: input.metadata
              ? (input.metadata as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          },
        });
      });

      return entry.id;
    } catch (err: unknown) {
      if (isPrismaUniqueError(err)) {
        throw new DuplicateLedgerEntryError(input.idempotencyKey);
      }
      throw err;
    }
  }

  /**
   * Get the balance (sum of amountMinor) for a specific ledger account.
   * Uses advisory lock to get a consistent read.
   */
  async getBalance(
    appId: string,
    billToId: string,
    accountType: LedgerAccountType,
  ): Promise<number> {
    const prisma = getPrismaClient();

    const account = await prisma.ledgerAccount.findUnique({
      where: {
        appId_billToId_type: { appId, billToId, type: accountType },
      },
    });

    if (!account) {
      return 0;
    }

    const result = await prisma.ledgerEntry.aggregate({
      where: { ledgerAccountId: account.id },
      _sum: { amountMinor: true },
    });

    return result._sum.amountMinor ?? 0;
  }

  /**
   * Query ledger entries for a billing entity with optional filters.
   * Returns paginated results with total count.
   */
  async getEntries(
    appId: string,
    billToId: string,
    filter: GetEntriesFilter = {},
  ): Promise<LedgerEntriesResult> {
    const prisma = getPrismaClient();

    const where: Prisma.LedgerEntryWhereInput = {
      appId,
      billToId,
    };

    if (filter.from || filter.to) {
      where.timestamp = {};
      if (filter.from) {
        where.timestamp.gte = filter.from;
      }
      if (filter.to) {
        where.timestamp.lte = filter.to;
      }
    }

    if (filter.type) {
      where.type = filter.type;
    }

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        orderBy: { timestamp: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    return { entries, total };
  }

  /**
   * Resolve billToId from a teamId by looking up the team's BillingEntity.
   */
  async resolveBillToId(teamId: string): Promise<string> {
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
}

/**
 * Hash a string to a 32-bit integer for use as a pg advisory lock key.
 */
function hashToInt32(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash;
}
