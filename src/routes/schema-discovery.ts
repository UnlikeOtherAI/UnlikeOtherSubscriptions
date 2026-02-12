import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getAllSchemas,
  getSchema,
  SchemaRegistryEntry,
} from "../services/usage-event-schema-registry.js";

const eventTypeParamSchema = z.object({
  eventType: z.string().min(1),
});

/**
 * Converts a SchemaRegistryEntry's Zod schema to a simplified JSON Schema
 * representation for API consumers.
 */
function zodSchemaToJsonSchema(entry: SchemaRegistryEntry): Record<string, unknown> {
  const shape = entry.schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [key, zodType] of Object.entries(shape)) {
    const prop = describeZodType(zodType);
    properties[key] = prop;

    if (!zodType.isOptional()) {
      required.push(key);
    }
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: true,
  };
}

function describeZodType(zodType: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap optional
  if (zodType instanceof z.ZodOptional) {
    return describeZodType(zodType.unwrap());
  }

  // String type
  if (zodType instanceof z.ZodString) {
    return { type: "string" };
  }

  // Number type (with int check)
  if (zodType instanceof z.ZodNumber) {
    const checks = (zodType as unknown as { _def: { checks: Array<{ kind: string }> } })._def.checks;
    const isInt = checks?.some((c) => c.kind === "int");
    return isInt ? { type: "integer" } : { type: "number" };
  }

  return { type: "unknown" };
}

function formatSchemaListItem(entry: SchemaRegistryEntry): Record<string, unknown> {
  return {
    eventType: entry.eventType,
    version: entry.version,
    status: entry.status,
    description: entry.description,
  };
}

export async function schemaDiscoveryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/schemas/usage-events", async (_request, reply) => {
    const schemas = getAllSchemas();
    const items = schemas.map(formatSchemaListItem);

    return reply.status(200).send({
      schemas: items,
    });
  });

  app.get("/v1/schemas/usage-events/:eventType", async (request, reply) => {
    const params = eventTypeParamSchema.parse(request.params);
    const entry = getSchema(params.eventType);

    if (!entry) {
      return reply.status(404).send({
        error: "Not Found",
        message: `Unknown event type: ${params.eventType}`,
        statusCode: 404,
        requestId: request.requestId,
      });
    }

    const jsonSchema = zodSchemaToJsonSchema(entry);

    return reply.status(200).send({
      eventType: entry.eventType,
      version: entry.version,
      status: entry.status,
      description: entry.description,
      schema: jsonSchema,
    });
  });
}
