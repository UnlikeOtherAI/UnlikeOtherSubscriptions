import { describe, it, expect } from "vitest";
import {
  BillingError,
  BillingApiError,
  BillingTimeoutError,
  BillingNetworkError,
  BillingValidationError,
} from "./errors.js";

describe("BillingError", () => {
  it("creates a base error with correct name", () => {
    const err = new BillingError("test");
    expect(err.name).toBe("BillingError");
    expect(err.message).toBe("test");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("BillingApiError", () => {
  it("extracts message from response body", () => {
    const err = new BillingApiError(400, { message: "Bad request" }, "req_123");
    expect(err.name).toBe("BillingApiError");
    expect(err.message).toBe("Bad request");
    expect(err.statusCode).toBe(400);
    expect(err.requestId).toBe("req_123");
    expect(err.responseBody).toEqual({ message: "Bad request" });
    expect(err).toBeInstanceOf(BillingError);
  });

  it("uses HTTP status as message when body has no message field", () => {
    const err = new BillingApiError(500, "Internal Server Error");
    expect(err.message).toBe("HTTP 500");
    expect(err.statusCode).toBe(500);
  });
});

describe("BillingTimeoutError", () => {
  it("includes timeout duration in message", () => {
    const err = new BillingTimeoutError(5000);
    expect(err.name).toBe("BillingTimeoutError");
    expect(err.message).toBe("Request timed out after 5000ms");
    expect(err).toBeInstanceOf(BillingError);
  });
});

describe("BillingNetworkError", () => {
  it("captures cause error", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new BillingNetworkError("Connection refused", cause);
    expect(err.name).toBe("BillingNetworkError");
    expect(err.message).toBe("Connection refused");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(BillingError);
  });
});

describe("BillingValidationError", () => {
  it("creates a validation error", () => {
    const err = new BillingValidationError("teamId is required");
    expect(err.name).toBe("BillingValidationError");
    expect(err.message).toBe("teamId is required");
    expect(err).toBeInstanceOf(BillingError);
  });
});
