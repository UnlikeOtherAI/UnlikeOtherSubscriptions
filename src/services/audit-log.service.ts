import { PrismaClient, Prisma } from "@prisma/client";
import { getPrismaClient } from "../lib/prisma.js";

export interface AuditLogInput {
  action: string;
  entityType: string;
  entityId: string;
  actor: string;
  metadata?: Record<string, unknown>;
}

export class AuditLogService {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async log(input: AuditLogInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actor: input.actor,
        metadata: input.metadata
          ? (input.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  }
}
