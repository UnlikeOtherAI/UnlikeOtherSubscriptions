import { signJwt } from "./jwt.js";
import { httpRequest } from "./http.js";
import { BillingValidationError } from "./errors.js";
import type {
  BillingClientConfig,
  UsageEvent,
  ReportUsageResult,
  EntitlementResult,
  CreateCheckoutOptions,
  CreateCheckoutResult,
} from "./types.js";

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_JWT_TTL_SECONDS = 60;
const DEFAULT_MAX_BATCH_SIZE = 1000;

export interface BillingClient {
  /**
   * Reports usage events to the billing service.
   * Validates batch size client-side and signs the request with a JWT.
   */
  reportUsage(events: UsageEvent[]): Promise<ReportUsageResult>;

  /**
   * Retrieves resolved entitlements for a team.
   */
  getEntitlements(teamId: string): Promise<EntitlementResult>;

  /**
   * Creates a Stripe Checkout session for a subscription.
   * Returns the checkout URL and session ID.
   */
  createCheckout(teamId: string, options: CreateCheckoutOptions): Promise<CreateCheckoutResult>;
}

/**
 * Creates a billing client configured for a specific App.
 * The appId is set once and included automatically in all requests.
 */
export function createBillingClient(config: BillingClientConfig): BillingClient {
  const {
    appId,
    secret,
    kid,
    baseUrl: rawBaseUrl,
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
    jwtTtlSeconds = DEFAULT_JWT_TTL_SECONDS,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
  } = config;

  // Normalize base URL (remove trailing slash)
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");

  function makeAuthHeaders(teamId?: string, userId?: string): Record<string, string> {
    const token = signJwt({
      appId,
      secret,
      kid,
      ttlSeconds: jwtTtlSeconds,
      teamId,
      userId,
    });

    return {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  async function reportUsage(events: UsageEvent[]): Promise<ReportUsageResult> {
    if (!Array.isArray(events) || events.length === 0) {
      throw new BillingValidationError("events must be a non-empty array");
    }

    if (events.length > maxBatchSize) {
      throw new BillingValidationError(
        `Batch size ${events.length} exceeds maximum of ${maxBatchSize}`
      );
    }

    const headers = makeAuthHeaders(events[0].teamId, events[0].userId);

    return httpRequest<ReportUsageResult>({
      method: "POST",
      url: `${baseUrl}/v1/apps/${encodeURIComponent(appId)}/usage/events`,
      headers,
      body: events,
      timeout,
      maxRetries,
    });
  }

  async function getEntitlements(teamId: string): Promise<EntitlementResult> {
    if (!teamId) {
      throw new BillingValidationError("teamId is required");
    }

    const headers = makeAuthHeaders(teamId);

    return httpRequest<EntitlementResult>({
      method: "GET",
      url: `${baseUrl}/v1/apps/${encodeURIComponent(appId)}/teams/${encodeURIComponent(teamId)}/entitlements`,
      headers,
      timeout,
      maxRetries,
    });
  }

  async function createCheckout(teamId: string, options: CreateCheckoutOptions): Promise<CreateCheckoutResult> {
    if (!teamId) {
      throw new BillingValidationError("teamId is required");
    }

    if (!options.planCode) {
      throw new BillingValidationError("planCode is required");
    }

    if (!options.successUrl) {
      throw new BillingValidationError("successUrl is required");
    }

    if (!options.cancelUrl) {
      throw new BillingValidationError("cancelUrl is required");
    }

    const headers = makeAuthHeaders(teamId);

    return httpRequest<CreateCheckoutResult>({
      method: "POST",
      url: `${baseUrl}/v1/apps/${encodeURIComponent(appId)}/teams/${encodeURIComponent(teamId)}/checkout/subscription`,
      headers,
      body: {
        planCode: options.planCode,
        successUrl: options.successUrl,
        cancelUrl: options.cancelUrl,
        seats: options.seats,
      },
      timeout,
      maxRetries,
    });
  }

  return { reportUsage, getEntitlements, createCheckout };
}
