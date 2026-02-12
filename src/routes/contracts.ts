import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ContractService,
  ContractNotFoundError,
  BundleNotFoundError,
  BillingEntityNotFoundError,
  ActiveContractExistsError,
} from "../services/contract.service.js";

const contractIdParamSchema = z.object({
  id: z.string().uuid(),
});

const createContractBodySchema = z.object({
  billToId: z.string().uuid(),
  bundleId: z.string().uuid(),
  currency: z.string().min(1).max(10),
  billingPeriod: z.enum(["MONTHLY", "QUARTERLY"]),
  termsDays: z.number().int().min(1),
  pricingMode: z.enum([
    "FIXED",
    "FIXED_PLUS_TRUEUP",
    "MIN_COMMIT_TRUEUP",
    "CUSTOM_INVOICE_ONLY",
  ]),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
});

const updateContractBodySchema = z.object({
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ENDED"]).optional(),
  termsDays: z.number().int().min(1).optional(),
  pricingMode: z
    .enum([
      "FIXED",
      "FIXED_PLUS_TRUEUP",
      "MIN_COMMIT_TRUEUP",
      "CUSTOM_INVOICE_ONLY",
    ])
    .optional(),
});

const overrideItemSchema = z.object({
  appId: z.string().uuid(),
  meterKey: z.string().min(1).max(255),
  limitType: z
    .enum(["NONE", "INCLUDED", "UNLIMITED", "HARD_CAP"])
    .optional(),
  includedAmount: z.number().int().nullable().optional(),
  overageBilling: z
    .enum(["NONE", "PER_UNIT", "TIERED", "CUSTOM"])
    .optional(),
  enforcement: z.enum(["NONE", "SOFT", "HARD"]).optional(),
  featureFlags: z.record(z.boolean()).nullable().optional(),
});

const replaceOverridesBodySchema = z.array(overrideItemSchema);

export async function contractRoutes(app: FastifyInstance): Promise<void> {
  const contractService = new ContractService();

  app.post("/v1/contracts", async (request, reply) => {
    const body = createContractBodySchema.parse(request.body);

    try {
      const contract = await contractService.createContract(body);
      return reply.status(201).send(contract);
    } catch (err) {
      if (err instanceof BillingEntityNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: "BillingEntity not found",
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      if (err instanceof BundleNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: "Bundle not found",
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });

  app.patch("/v1/contracts/:id", async (request, reply) => {
    const params = contractIdParamSchema.parse(request.params);
    const body = updateContractBodySchema.parse(request.body);

    try {
      const contract = await contractService.updateContract(params.id, body);
      return reply.status(200).send(contract);
    } catch (err) {
      if (err instanceof ContractNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: "Contract not found",
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      if (err instanceof ActiveContractExistsError) {
        return reply.status(409).send({
          error: "Conflict",
          message: err.message,
          statusCode: 409,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });

  app.put("/v1/contracts/:id/overrides", async (request, reply) => {
    const params = contractIdParamSchema.parse(request.params);
    const body = replaceOverridesBodySchema.parse(request.body);

    try {
      const overrides = await contractService.replaceOverrides(
        params.id,
        body,
      );
      return reply.status(200).send(overrides);
    } catch (err) {
      if (err instanceof ContractNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: "Contract not found",
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });
}
