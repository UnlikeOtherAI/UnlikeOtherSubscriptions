/** Base error for all billing SDK errors. */
export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

/** Thrown when the billing service returns an HTTP error. */
export class BillingApiError extends BillingError {
  readonly statusCode: number;
  readonly responseBody: unknown;
  readonly requestId?: string;

  constructor(statusCode: number, responseBody: unknown, requestId?: string) {
    const message = typeof responseBody === "object" && responseBody !== null && "message" in responseBody
      ? String((responseBody as { message: string }).message)
      : `HTTP ${statusCode}`;
    super(message);
    this.name = "BillingApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.requestId = requestId;
  }
}

/** Thrown when a request times out. */
export class BillingTimeoutError extends BillingError {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "BillingTimeoutError";
  }
}

/** Thrown when a network error occurs. */
export class BillingNetworkError extends BillingError {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "BillingNetworkError";
    this.cause = cause;
  }
}

/** Thrown when client-side validation fails. */
export class BillingValidationError extends BillingError {
  constructor(message: string) {
    super(message);
    this.name = "BillingValidationError";
  }
}
