import { getPrismaClient } from "../lib/prisma.js";
import { Prisma, LedgerEntryType, LedgerReferenceType, LedgerAccountType } from "@prisma/client";

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

export class DuplicateLedgerEntryError extends Error {
  constructor(idempotencyKey: string) {
    super(`Duplicate ledger entry: ${idempotencyKey}`);
    this.name = "DuplicateLedgerEntryError";
  }
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
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
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
   * Create a ledger entry with idempotency protection.
   * Uses the idempotencyKey unique constraint to prevent duplicate entries.
   */
  async createEntry(input: CreateLedgerEntryInput): Promise<string> {
    const prisma = getPrismaClient();

    const ledgerAccountId = await this.getOrCreateAccount(
      input.appId,
      input.billToId,
      input.accountType,
    );

    try {
      const entry = await prisma.ledgerEntry.create({
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
      return entry.id;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        throw new DuplicateLedgerEntryError(input.idempotencyKey);
      }
      throw err;
    }
  }
}
