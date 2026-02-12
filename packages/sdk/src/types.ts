/** Configuration for creating a billing client. */
export interface BillingClientConfig {
  /** The App ID assigned by the billing service. */
  appId: string;
  /** The HMAC shared secret for JWT signing. */
  secret: string;
  /** The key ID associated with the secret. */
  kid: string;
  /** Base URL of the billing service (e.g. https://billing.example.com). */
  baseUrl: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
  /** Maximum number of retries on transient errors. Defaults to 3. */
  maxRetries?: number;
  /** JWT TTL in seconds. Defaults to 60. */
  jwtTtlSeconds?: number;
  /** Maximum batch size for usage events. Defaults to 1000. */
  maxBatchSize?: number;
}

/** A usage event to report to the billing service. */
export interface UsageEvent {
  /** Unique deduplication key per App. */
  idempotencyKey: string;
  /** Versioned namespaced event type (e.g. llm.tokens.v1). */
  eventType: string;
  /** Event timestamp in ISO 8601 format. */
  timestamp: string;
  /** Team ID. Required unless userId is provided. */
  teamId?: string;
  /** User ID for attribution. If provided without teamId, server resolves from Personal Team. */
  userId?: string;
  /** Event payload (validated against eventType schema). */
  payload: Record<string, unknown>;
  /** Source service name and version (e.g. my-tool/1.0.0). */
  source: string;
}

/** Response from the usage reporting endpoint. */
export interface ReportUsageResult {
  accepted: number;
  duplicates: number;
}

/** Meter policy for a specific meter. */
export interface MeterPolicy {
  limitType: "NONE" | "INCLUDED" | "UNLIMITED" | "HARD_CAP";
  includedAmount?: number;
  enforcement: "NONE" | "SOFT" | "HARD";
  overageBilling: "NONE" | "PER_UNIT" | "TIERED" | "CUSTOM";
}

/** Resolved entitlement result for a team. */
export interface EntitlementResult {
  features: Record<string, boolean>;
  meterPolicies: Record<string, MeterPolicy>;
  billingMode: "SUBSCRIPTION" | "WALLET" | "HYBRID" | "ENTERPRISE_CONTRACT";
  billable: Record<string, boolean>;
}

/** Options for creating a subscription checkout session. */
export interface CreateCheckoutOptions {
  /** Plan code to subscribe to. */
  planCode: string;
  /** URL to redirect to on success. */
  successUrl: string;
  /** URL to redirect to on cancellation. */
  cancelUrl: string;
  /** Number of seats (if applicable). */
  seats?: number;
}

/** Response from checkout creation. */
export interface CreateCheckoutResult {
  url: string;
  sessionId?: string;
}

/** JWT claims structure matching the billing service expectations. */
export interface JwtClaims {
  iss: string;
  aud: string;
  sub: string;
  appId: string;
  teamId?: string;
  userId?: string;
  scopes: string[];
  iat: number;
  exp: number;
  jti: string;
  kid: string;
}
