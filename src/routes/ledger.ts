import { FastifyInstance } from "fastify";
import { z } from "zod";
import { LedgerEntryType } from "@prisma/client";
import {
  LedgerService,
  TeamNotFoundError,
  BillingEntityNotFoundError,
} from "../services/ledger.service.js";

const paramsSchema = z.object({
  appId: z.string().uuid(),
  teamId: z.string().uuid(),
});

const VALID_ENTRY_TYPES: string[] = [
  "TOPUP",
  "SUBSCRIPTION_CHARGE",
  "USAGE_CHARGE",
  "REFUND",
  "ADJUSTMENT",
  "INVOICE_PAYMENT",
  "COGS_ACCRUAL",
];

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  type: z.enum(VALID_ENTRY_TYPES as [string, ...string[]]).optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : undefined))
    .pipe(z.number().int().min(1).max(100).optional()),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : undefined))
    .pipe(z.number().int().min(0).optional()),
});

export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  const ledgerService = new LedgerService();

  app.get(
    "/v1/apps/:appId/teams/:teamId/ledger",
    async (request, reply) => {
      const params = paramsSchema.parse(request.params);
      const query = querySchema.parse(request.query);

      const claims = request.jwtClaims;
      if (!claims || claims.appId !== params.appId) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "JWT appId does not match route appId",
          statusCode: 403,
          requestId: request.requestId,
        });
      }

      try {
        const billToId = await ledgerService.resolveBillToId(params.teamId);

        const result = await ledgerService.getEntries(
          params.appId,
          billToId,
          {
            from: query.from ? new Date(query.from) : undefined,
            to: query.to ? new Date(query.to) : undefined,
            type: query.type as LedgerEntryType | undefined,
            limit: query.limit,
            offset: query.offset,
          },
        );

        return reply.status(200).send({
          entries: result.entries,
          total: result.total,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
        });
      } catch (err) {
        if (
          err instanceof TeamNotFoundError ||
          err instanceof BillingEntityNotFoundError
        ) {
          return reply.status(404).send({
            error: "Not Found",
            message: err.message,
            statusCode: 404,
            requestId: request.requestId,
          });
        }
        throw err;
      }
    },
  );
}
