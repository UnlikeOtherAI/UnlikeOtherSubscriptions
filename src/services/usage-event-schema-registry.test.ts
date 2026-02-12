import { describe, it, expect } from "vitest";
import {
  getSchema,
  getAllSchemas,
  isRegisteredEventType,
  validateEventPayload,
} from "./usage-event-schema-registry.js";

describe("UsageEventSchemaRegistry", () => {
  describe("registry contents", () => {
    it("registers all four V1 schemas", () => {
      const schemas = getAllSchemas();
      const eventTypes = schemas.map((s) => s.eventType).sort();
      expect(eventTypes).toEqual([
        "bandwidth.sample.v1",
        "llm.image.v1",
        "llm.tokens.v1",
        "storage.sample.v1",
      ]);
    });

    it("returns schema entry by eventType", () => {
      const entry = getSchema("llm.tokens.v1");
      expect(entry).toBeDefined();
      expect(entry!.version).toBe("v1");
      expect(entry!.status).toBe("active");
      expect(entry!.description).toContain("token");
    });

    it("returns undefined for unregistered eventType", () => {
      expect(getSchema("unknown.thing.v1")).toBeUndefined();
    });

    it("isRegisteredEventType returns true for known types", () => {
      expect(isRegisteredEventType("llm.tokens.v1")).toBe(true);
      expect(isRegisteredEventType("llm.image.v1")).toBe(true);
      expect(isRegisteredEventType("storage.sample.v1")).toBe(true);
      expect(isRegisteredEventType("bandwidth.sample.v1")).toBe(true);
    });

    it("isRegisteredEventType returns false for unknown types", () => {
      expect(isRegisteredEventType("unknown.thing.v1")).toBe(false);
      expect(isRegisteredEventType("llm.tokens.v2")).toBe(false);
    });
  });

  describe("llm.tokens.v1 validation", () => {
    it("accepts valid payload", () => {
      const result = validateEventPayload("llm.tokens.v1", {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1200,
        outputTokens: 350,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts payload with optional cachedTokens", () => {
      const result = validateEventPayload("llm.tokens.v1", {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1200,
        outputTokens: 350,
        cachedTokens: 200,
      });
      expect(result.valid).toBe(true);
    });

    it("allows extra fields (tolerant reader)", () => {
      const result = validateEventPayload("llm.tokens.v1", {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1200,
        outputTokens: 350,
        customField: "extra",
        anotherCustom: 42,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects missing provider with field-level error", () => {
      const result = validateEventPayload("llm.tokens.v1", {
        model: "gpt-5",
        inputTokens: 1200,
        outputTokens: 350,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "provider")).toBe(true);
    });

    it("rejects missing model with field-level error", () => {
      const result = validateEventPayload("llm.tokens.v1", {
        provider: "openai",
        inputTokens: 1200,
        outputTokens: 350,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "model")).toBe(true);
    });

    it("rejects missing inputTokens", () => {
      const result = validateEventPayload("llm.tokens.v1", {
        provider: "openai",
        model: "gpt-5",
        outputTokens: 350,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "inputTokens")).toBe(true);
    });

    it("rejects missing outputTokens", () => {
      const result = validateEventPayload("llm.tokens.v1", {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1200,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "outputTokens")).toBe(true);
    });

    it("rejects non-integer inputTokens", () => {
      const result = validateEventPayload("llm.tokens.v1", {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 12.5,
        outputTokens: 350,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "inputTokens")).toBe(true);
    });
  });

  describe("llm.image.v1 validation", () => {
    it("accepts valid payload", () => {
      const result = validateEventPayload("llm.image.v1", {
        provider: "openai",
        model: "dall-e-3",
        width: 1024,
        height: 1024,
        count: 1,
      });
      expect(result.valid).toBe(true);
    });

    it("allows extra fields (tolerant reader)", () => {
      const result = validateEventPayload("llm.image.v1", {
        provider: "openai",
        model: "dall-e-3",
        width: 1024,
        height: 1024,
        count: 1,
        quality: "hd",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects missing width", () => {
      const result = validateEventPayload("llm.image.v1", {
        provider: "openai",
        model: "dall-e-3",
        height: 1024,
        count: 1,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "width")).toBe(true);
    });

    it("rejects missing height", () => {
      const result = validateEventPayload("llm.image.v1", {
        provider: "openai",
        model: "dall-e-3",
        width: 1024,
        count: 1,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "height")).toBe(true);
    });

    it("rejects missing count", () => {
      const result = validateEventPayload("llm.image.v1", {
        provider: "openai",
        model: "dall-e-3",
        width: 1024,
        height: 1024,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "count")).toBe(true);
    });

    it("rejects zero count", () => {
      const result = validateEventPayload("llm.image.v1", {
        provider: "openai",
        model: "dall-e-3",
        width: 1024,
        height: 1024,
        count: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "count")).toBe(true);
    });

    it("rejects missing provider and model", () => {
      const result = validateEventPayload("llm.image.v1", {
        width: 1024,
        height: 1024,
        count: 1,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "provider")).toBe(true);
      expect(result.errors.some((e) => e.field === "model")).toBe(true);
    });
  });

  describe("storage.sample.v1 validation", () => {
    it("accepts valid payload", () => {
      const result = validateEventPayload("storage.sample.v1", {
        bytesUsed: 1048576,
      });
      expect(result.valid).toBe(true);
    });

    it("allows extra fields (tolerant reader)", () => {
      const result = validateEventPayload("storage.sample.v1", {
        bytesUsed: 1048576,
        region: "us-east-1",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects missing bytesUsed", () => {
      const result = validateEventPayload("storage.sample.v1", {});
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "bytesUsed")).toBe(true);
    });

    it("accepts zero bytesUsed", () => {
      const result = validateEventPayload("storage.sample.v1", {
        bytesUsed: 0,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects negative bytesUsed", () => {
      const result = validateEventPayload("storage.sample.v1", {
        bytesUsed: -100,
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("bandwidth.sample.v1 validation", () => {
    it("accepts valid payload", () => {
      const result = validateEventPayload("bandwidth.sample.v1", {
        bytesIn: 5000,
        bytesOut: 12000,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts payload with optional bytesOutInternal", () => {
      const result = validateEventPayload("bandwidth.sample.v1", {
        bytesIn: 5000,
        bytesOut: 12000,
        bytesOutInternal: 3000,
      });
      expect(result.valid).toBe(true);
    });

    it("allows extra fields (tolerant reader)", () => {
      const result = validateEventPayload("bandwidth.sample.v1", {
        bytesIn: 5000,
        bytesOut: 12000,
        region: "eu-west-1",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects missing bytesIn", () => {
      const result = validateEventPayload("bandwidth.sample.v1", {
        bytesOut: 12000,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "bytesIn")).toBe(true);
    });

    it("rejects missing bytesOut", () => {
      const result = validateEventPayload("bandwidth.sample.v1", {
        bytesIn: 5000,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "bytesOut")).toBe(true);
    });

    it("accepts zero values", () => {
      const result = validateEventPayload("bandwidth.sample.v1", {
        bytesIn: 0,
        bytesOut: 0,
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("unknown eventType", () => {
    it("returns eventType field error for unknown type", () => {
      const result = validateEventPayload("custom.unknown.v1", { foo: "bar" });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe("eventType");
      expect(result.errors[0].message).toContain("Unknown event type");
    });
  });
});
