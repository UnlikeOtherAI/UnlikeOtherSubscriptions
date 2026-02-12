import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BundleService,
  BundleNotFoundError,
  BundleCodeConflictError,
} from "../services/bundle.service.js";

const bundleIdParamSchema = z.object({
  id: z.string().uuid(),
});

const bundleAppSchema = z.object({
  appId: z.string().uuid(),
  defaultFeatureFlags: z.record(z.boolean()).nullable().optional(),
});

const bundleMeterPolicySchema = z.object({
  appId: z.string().uuid(),
  meterKey: z.string().min(1).max(255),
  limitType: z.enum(["NONE", "INCLUDED", "UNLIMITED", "HARD_CAP"]),
  includedAmount: z.number().int().nullable().optional(),
  enforcement: z.enum(["NONE", "SOFT", "HARD"]).optional(),
  overageBilling: z.enum(["NONE", "PER_UNIT", "TIERED", "CUSTOM"]).optional(),
  notes: z.string().nullable().optional(),
});

const createBundleBodySchema = z.object({
  code: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  apps: z.array(bundleAppSchema).optional(),
  meterPolicies: z.array(bundleMeterPolicySchema).optional(),
});

const updateBundleBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  apps: z.array(bundleAppSchema).optional(),
  meterPolicies: z.array(bundleMeterPolicySchema).optional(),
});

export async function bundleRoutes(app: FastifyInstance): Promise<void> {
  const bundleService = new BundleService();

  app.post("/v1/bundles", async (request, reply) => {
    const body = createBundleBodySchema.parse(request.body);

    try {
      const bundle = await bundleService.createBundle(body);
      return reply.status(201).send(bundle);
    } catch (err) {
      if (err instanceof BundleCodeConflictError) {
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

  app.patch("/v1/bundles/:id", async (request, reply) => {
    const params = bundleIdParamSchema.parse(request.params);
    const body = updateBundleBodySchema.parse(request.body);

    try {
      const bundle = await bundleService.updateBundle(params.id, body);
      return reply.status(200).send(bundle);
    } catch (err) {
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
}
