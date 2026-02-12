import { z, ZodObject, ZodRawShape } from "zod";

/**
 * Registry that maps eventType strings to Zod schema definitions.
 * V1 schemas are hardcoded; new schemas can be registered at runtime
 * for extensibility without code changes.
 */

export interface SchemaRegistryEntry {
  eventType: string;
  version: string;
  status: "active" | "deprecated";
  schema: ZodObject<ZodRawShape>;
  description: string;
}

export interface PayloadValidationError {
  field: string;
  message: string;
}

export interface PayloadValidationResult {
  valid: boolean;
  errors: PayloadValidationError[];
}

// ── V1 Schema Definitions ──────────────────────────────────────────

const llmTokensV1Schema = z.object({
  provider: z.string().min(1, "provider is required"),
  model: z.string().min(1, "model is required"),
  inputTokens: z.number().int().nonnegative("inputTokens must be a non-negative integer"),
  outputTokens: z.number().int().nonnegative("outputTokens must be a non-negative integer"),
  cachedTokens: z.number().int().nonnegative().optional(),
}).passthrough();

const llmImageV1Schema = z.object({
  provider: z.string().min(1, "provider is required"),
  model: z.string().min(1, "model is required"),
  width: z.number().int().positive("width must be a positive integer"),
  height: z.number().int().positive("height must be a positive integer"),
  count: z.number().int().positive("count must be a positive integer"),
}).passthrough();

const storageSampleV1Schema = z.object({
  bytesUsed: z.number().int().nonnegative("bytesUsed must be a non-negative integer"),
}).passthrough();

const bandwidthSampleV1Schema = z.object({
  bytesIn: z.number().int().nonnegative("bytesIn must be a non-negative integer"),
  bytesOut: z.number().int().nonnegative("bytesOut must be a non-negative integer"),
  bytesOutInternal: z.number().int().nonnegative().optional(),
}).passthrough();

// ── Registry ───────────────────────────────────────────────────────

const registry = new Map<string, SchemaRegistryEntry>();

function registerSchema(entry: SchemaRegistryEntry): void {
  registry.set(entry.eventType, entry);
}

// Register V1 schemas
registerSchema({
  eventType: "llm.tokens.v1",
  version: "v1",
  status: "active",
  schema: llmTokensV1Schema,
  description: "LLM token usage — tracks input and output token counts per request",
});

registerSchema({
  eventType: "llm.image.v1",
  version: "v1",
  status: "active",
  schema: llmImageV1Schema,
  description: "LLM image generation — tracks image dimensions and count",
});

registerSchema({
  eventType: "storage.sample.v1",
  version: "v1",
  status: "active",
  schema: storageSampleV1Schema,
  description: "Storage usage sample — point-in-time bytes stored",
});

registerSchema({
  eventType: "bandwidth.sample.v1",
  version: "v1",
  status: "active",
  schema: bandwidthSampleV1Schema,
  description: "Bandwidth usage sample — bytes transferred in and out",
});

// ── Public API ─────────────────────────────────────────────────────

export function getSchema(eventType: string): SchemaRegistryEntry | undefined {
  return registry.get(eventType);
}

export function getAllSchemas(): SchemaRegistryEntry[] {
  return Array.from(registry.values());
}

export function isRegisteredEventType(eventType: string): boolean {
  return registry.has(eventType);
}

/**
 * Validates an event payload against the registered schema for its eventType.
 * Returns field-level validation errors if the payload is invalid.
 */
export function validateEventPayload(
  eventType: string,
  payload: Record<string, unknown>,
): PayloadValidationResult {
  const entry = registry.get(eventType);
  if (!entry) {
    return {
      valid: false,
      errors: [{ field: "eventType", message: `Unknown event type: ${eventType}` }],
    };
  }

  const result = entry.schema.safeParse(payload);
  if (result.success) {
    return { valid: true, errors: [] };
  }

  const errors: PayloadValidationError[] = result.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "payload",
    message: issue.message,
  }));

  return { valid: false, errors };
}

export class UnknownEventTypeError extends Error {
  public readonly eventType: string;
  constructor(eventType: string) {
    super(`Unknown event type: ${eventType}`);
    this.name = "UnknownEventTypeError";
    this.eventType = eventType;
  }
}

export class PayloadValidationFailedError extends Error {
  public readonly eventType: string;
  public readonly validationErrors: PayloadValidationError[];
  constructor(eventType: string, errors: PayloadValidationError[]) {
    const fieldMessages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    super(`Invalid payload for ${eventType}: ${fieldMessages}`);
    this.name = "PayloadValidationFailedError";
    this.eventType = eventType;
    this.validationErrors = errors;
  }
}
