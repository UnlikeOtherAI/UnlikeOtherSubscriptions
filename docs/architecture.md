# UnlikeOtherSubscriptions — Architecture

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js |
| HTTP Framework | Fastify (or Nest) |
| ORM | Prisma |
| Database | PostgreSQL |
| Queue | pg-boss (Postgres-backed) or BullMQ (Redis) |
| Payments | Stripe |
| Validation | Zod |
| Logging | Pino (structured) |
| Frontend (Admin) | Vite |

---

## System Architecture

The service is structured as a single deployable containing four internal components:

### 1. HTTP API

- JWT-authenticated endpoints (per-App verification)
- Request validation via Zod
- Idempotency layer on all mutation endpoints

### 2. Stripe Webhook Handler

- Raw body handling for signature verification
- Idempotent event processing (stores `event.id` to reject duplicates)
- Routes events to domain handlers

### 3. Background Workers

- **Pricing Engine Runner** — transforms `UsageEvent` rows into `BillableLineItem` rows
- **Period Closer** — generates invoices / reports metered usage to Stripe at billing period end
- **Entitlement Cache Refresh** — recomputes cached entitlements after state changes
- **Seat Sync Queue** — updates Stripe subscription item quantities when team membership changes

### 4. Observability

- Structured JSON logs (Pino) with request correlation IDs
- Audit log table for admin/manual actions
- Metrics: ingestion lag, webhook failure rate, billing run status

---

## Data Model (Postgres + Prisma)

### Multi-Tenant Foundations

#### App
- `id`, `name`, `status`
- Auth secrets (separate table: `kid`, hashed/encrypted secret)
- Stripe configuration (single account or connected accounts)

#### Team
- `id`, `name`
- `defaultCurrency`
- `stripeCustomerId` (nullable until Stripe customer is created)
- `billingMode` — `subscription` | `wallet` | `hybrid` | `enterprise`

#### BillingEntity
- `id`
- `type` — `TEAM` (V1 only; future: `ORG`)
- `teamId` (unique; nullable when `ORG` type arrives)

All "who pays" references throughout the schema use `billToId` pointing to `BillingEntity.id`, **not** directly to `teamId`. This means when Org/Group billing is introduced later, a new `BillingEntity(type=ORG)` row is created and financial records reference it — no schema rewrite required.

#### ExternalTeamRef
- `appId`, `externalTeamId` — the tool's own team identifier
- `billingTeamId` — resolves to the global billing Team

Team IDs are **global across apps**. Each app maps its own team records to the billing Team via `ExternalTeamRef`. Enterprise "all apps" access only works cleanly when every app points to the same billing Team.

#### User
- `id`, `appId`
- `email`, `externalRef` (the tool's own user ID)

#### TeamMember
- `teamId`, `userId`, `role`, `status`
- `startedAt`, `endedAt` (for seat history and proration)

### Subscriptions & Products

#### Plan / Addon
- `id`, `appId`, `code`, `name`

#### StripeProductMap
- `appId`, `planId` or `addonId`
- `stripeProductId`, `stripePriceId`
- `kind` — `base` | `seat` | `addon` | `overage` | `topup`

#### TeamSubscription
- `teamId`, `stripeSubscriptionId`, `status`
- `planId`, `currentPeriodStart`, `currentPeriodEnd`
- `seatsQuantity` (cached from Stripe)

#### TeamAddon
- `teamId`, `addonId`, `status`, `quantity`

### Bundles & Enterprise Contracts

#### Bundle
- `id`, `code`, `name`, `status`
- Represents a named set of apps + default entitlements (e.g. `BUNDLE_ALL_APPS_ENTERPRISE`)

#### BundleApp
- `bundleId`, `appId`
- Optional default feature flags for that app within the bundle

#### BundleMeterPolicy
- `bundleId`, `appId`
- `meterKey` (e.g. `llm.tokens.in`, `llm.image`, `storage.bytes_gb_month`, `net.egress.internet_bytes`)
- `limitType` — `NONE` | `INCLUDED` | `UNLIMITED` | `HARD_CAP`
- `includedAmount` (only when `INCLUDED`)
- `enforcement` — `NONE` | `SOFT` | `HARD`
- `overageBilling` — `NONE` | `PER_UNIT` | `TIERED` | `CUSTOM`
- `notes`

#### Contract
- `id`, `billToId` (references `BillingEntity.id`; V1: always a Team's billing entity)
- `status` — `draft` | `active` | `paused` | `ended`
- `bundleId` (primary; may support multiple bundles)
- `currency`, `billingPeriod` (`monthly` | `quarterly`)
- `termsDays` (e.g. net 30)
- `startsAt`, `endsAt` (nullable for evergreen)
- `pricingMode` — `FIXED` | `FIXED_PLUS_TRUEUP` | `MIN_COMMIT_TRUEUP` | `CUSTOM_INVOICE_ONLY`
- **V1 constraint:** unique partial index `(billToId) WHERE status = 'ACTIVE'` — at most one active contract per billing entity

#### ContractRateCard
- `contractId`, `kind` (`CUSTOMER` | `COGS`)
- `effectiveFrom`, `effectiveTo`
- Rate rules follow the same structure as `PriceBook` / `PriceRule`

#### ContractOverride
- `contractId`, `appId`
- `meterKey`
- Overrides the bundle policy: `limitType`, `includedAmount`, `overageBilling`, `enforcement`
- Optional override feature flags

### Invoicing

Internal canonical invoices for export to Xero/QuickBooks or manual billing.

#### Invoice
- `id`, `billToId` (references `BillingEntity.id`), `contractId`
- `periodStart`, `periodEnd`
- `status` — `draft` | `issued` | `paid` | `void`
- `subtotalMinor`, `taxMinor`, `totalMinor`
- `externalRef` (Xero ID / manual invoice number, nullable)
- `issuedAt`, `dueAt`

#### InvoiceLineItem
- `invoiceId`, `appId` (nullable)
- `type` — `BASE_FEE` | `USAGE_TRUEUP` | `ADDON` | `CREDIT` | `ADJUSTMENT`
- `description`
- `quantity`, `unitPriceMinor`, `amountMinor`
- `usageSummary` (JSONB — for audit: meters, totals, rule IDs)

### Usage (Immutable)

#### UsageEvent
- `id` (UUID), `appId`, `teamId`, `billToId` (references `BillingEntity.id`), `userId` (optional)
- `eventType` — namespaced string (`llm.tokens`, `llm.image`, `storage.sample`, `bandwidth.sample`)
- `timestamp`, `idempotencyKey` (unique per `appId`)
- `payload` (JSONB)
- Indexes: `(appId, teamId, timestamp)`, `(billToId, timestamp)`, unique `(appId, idempotencyKey)`

`teamId` is always present for per-app enforcement and reporting. `billToId` enables billing rollups (V1: same as the team's billing entity; future: may point to an org-level entity).

**Payload examples:**

```json
// llm.tokens
{ "provider": "openai", "model": "gpt-5", "inputTokens": 1200, "outputTokens": 350, "cachedTokens": 800 }

// llm.image
{ "provider": "openai", "model": "gpt-image-1", "width": 1024, "height": 1024, "count": 2 }

// storage.sample
{ "bytesUsed": 9876543210 }

// bandwidth.sample
{ "bytesIn": 123456, "bytesOut": 654321, "bytesOutInternal": 111111 }
```

### Pricing

#### PriceBook
- `id`, `appId`, `kind` (`cogs` | `customer`), `currency`
- `version`, `effectiveFrom`, `effectiveTo`

Two price books exist per App:
1. **COGS PriceBook** — what you pay providers
2. **Customer PriceBook** — what you charge customers

#### PriceRule
- `priceBookId`, `priority` (highest wins)
- `match` (JSONB) — filters on `provider`, `model`, `eventType` (wildcards allowed)
- `rule` (JSONB) — pricing logic: `flat` | `per_unit` | `tiered` | `formula`

```json
{
  "type": "formula",
  "formula": "ceil((width*height)/1000000) * rate_per_mp",
  "params": { "rate_per_mp": 0.02 }
}
```

### Billable Line Items (Immutable)

#### BillableLineItem
- `id`, `appId`, `teamId`, `userId` (optional)
- `usageEventId` (nullable if derived from aggregate)
- `timestamp`, `priceBookId`, `priceRuleId`
- `amountMinor`, `currency`
- `description`
- `inputsSnapshot` (JSONB — captures the inputs used for computation so invoices are reproducible even after price changes)

### Ledger

#### LedgerAccount
- `id`, `appId`, `billToId` (references `BillingEntity.id`)
- `type` — `wallet` | `accounts_receivable` | `revenue` | `cogs` | `tax`

#### LedgerEntry
- `id`, `appId`, `billToId` (references `BillingEntity.id`), `timestamp`
- `type` — `topup` | `subscription_charge` | `usage_charge` | `refund` | `adjustment` | `invoice_payment` | `cogs_accrual`
- `amountMinor` (positive = credit, negative = debit), `currency`
- `referenceType` — `stripe_invoice` | `stripe_payment_intent` | `usage_event` | `manual`
- `referenceId`, `metadata` (JSONB)
- Indexes: `(billToId, timestamp)`, unique idempotency key for financial actions

Ledger entries are **only** created by: Stripe webhook handlers, billing runs, or audited admin actions.

---

## API Surface

All endpoints require `Authorization: Bearer <jwt>` except the Stripe webhook.

### Identity & Provisioning

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/apps/:appId/teams` | Create or ensure a Team exists (idempotent) |
| `POST` | `/v1/apps/:appId/teams/:teamId/users` | Ensure user + membership exists; updates seat count |

### Entitlements

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/apps/:appId/teams/:teamId/entitlements` | Returns merged entitlement view (plan + bundle + contract overrides) |

### Usage Ingestion

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/apps/:appId/usage/events` | Batch array of `UsageEvent` with idempotency keys |

### Ledger & Billing

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/apps/:appId/teams/:teamId/ledger` | Query ledger entries (`?from=&to=`) |
| `POST` | `/v1/apps/:appId/teams/:teamId/checkout/subscription` | Create Stripe Checkout session, returns URL |
| `POST` | `/v1/apps/:appId/teams/:teamId/checkout/topup` | One-time wallet top-up purchase |
| `POST` | `/v1/apps/:appId/teams/:teamId/portal` | Create Stripe customer portal session URL |

### Enterprise Contracts & Bundles (Admin Only)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/contracts` | Create a new enterprise contract |
| `PATCH` | `/v1/contracts/:id` | Update contract status, terms, or pricing mode |
| `PUT` | `/v1/contracts/:id/overrides` | Set per-app/meter overrides for a contract |
| `POST` | `/v1/bundles` | Create a new bundle |
| `PATCH` | `/v1/bundles/:id` | Update bundle apps or meter policies |

### Usage Reporting (Enterprise)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/teams/:teamId/usage` | Query usage (`?from=&to=&groupBy=app\|meter\|provider\|model`) |
| `GET` | `/v1/teams/:teamId/cogs` | Internal COGS report (`?from=&to=`) |

### Invoice Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/invoices/generate` | Generate invoice (`?teamId=&periodStart=&periodEnd=`) |
| `GET` | `/v1/invoices/:id` | Retrieve invoice details |
| `POST` | `/v1/invoices/:id/export` | Export as PDF/JSON for external systems |
| `POST` | `/v1/invoices/:id/mark-paid` | Admin action to mark as paid (audited) |

### Stripe Webhook

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/stripe/webhook` | No JWT — verified via Stripe signature |

**Handled webhook events:**
- `checkout.session.completed`
- `customer.subscription.*`
- `invoice.paid`, `invoice.payment_failed`
- `payment_intent.succeeded`, `payment_intent.failed`

---

## Service-to-Service Authentication

### Principle

Each App holds a shared HMAC secret with the Billing service. Requests are authenticated via short-lived signed JWTs.

### JWT Claims

| Claim | Description |
|-------|-------------|
| `iss` | `app:{appId}` |
| `aud` | `billing-service` |
| `sub` | `team:{teamId}` (or `user:{userId}`) |
| `appId` | Issuing application |
| `teamId` | Target team |
| `userId` | Acting user (optional) |
| `scopes` | e.g. `["usage:write", "billing:read", "entitlements:read"]` |
| `iat` / `exp` | Issued-at and expiry (short TTL: 60–300s) |
| `jti` | Nonce (for replay protection) |
| `kid` | Key ID (for secret rotation) |
| `reqHash` | Optional hash of method + path + body |

### Replay Protection

- TLS required
- Short `exp` window
- Store `jti` values for the `exp` duration (Redis or Postgres) to reject duplicates on sensitive endpoints

---

## Stripe Integration

### Credential Management

The Billing service **owns** all Stripe secrets (stored in env / Vault / KMS). Tools never hold or transmit Stripe API keys. If per-tool Stripe accounts are needed, use Stripe Connect or a one-time bootstrap registration — never pass keys in JWTs.

### Object Mapping

| Domain Concept | Stripe Object |
|----------------|---------------|
| Team | Customer |
| Plan / Add-on | Product + Price |
| Seats | Subscription Item (`quantity`) |
| Wallet top-up | PaymentIntent / Checkout (one-time) |
| Overages | Invoice Items or Metered Usage |

---

## Core Workflows

### A — Team Creation + Entitlements

1. Tool creates Team in its own DB
2. Tool calls `POST /teams` on Billing service
3. Billing creates Team record (and optionally a Stripe Customer)
4. Tool calls `GET /entitlements` to determine feature access

### B — Subscription Checkout

1. Tool calls `POST /checkout/subscription` with plan, add-ons, and seat config
2. Billing creates a Stripe Checkout Session and returns the URL
3. Tool redirects user to Stripe
4. Stripe fires `checkout.session.completed` webhook
5. Billing updates `TeamSubscription`, writes ledger entry, recomputes entitlements
6. Tool learns new state via `GET /entitlements` (or optional callback webhook)

### C — Usage Ingestion to Billing

1. Tool batches and posts usage events periodically
2. Billing writes `UsageEvent` rows (idempotent on `idempotencyKey`)
3. Async worker matches events to `PriceRule`, creates `BillableLineItem` rows
4. Depending on billing mode:
   - **Wallet:** debit ledger entries created (immediate or daily batch); auto-top-up if balance is low
   - **Subscription:** accumulate billables; create Stripe invoice items or report metered usage at period end

### D — Seat-Based Licensing

1. Tool membership changes trigger a call to Billing `POST /teams/:teamId/users`
2. Billing recalculates active seats and updates Stripe subscription item quantity (async, idempotent)

### E — Refunds & Disputes

- Stripe webhooks trigger reversal ledger entries
- Entitlements may change if payment fails (grace period logic applies)

### F — Enterprise Contract Billing (Period Close)

1. Period close worker runs at the end of each billing period for active contracts
2. Aggregates usage per app and meter for the contract period
3. Depending on `pricingMode`:
   - **FIXED:** generates invoice with a single `BASE_FEE` line, optional usage summary at zero charge
   - **FIXED_PLUS_TRUEUP:** `BASE_FEE` line + `USAGE_TRUEUP` lines for any meters exceeding included amounts
   - **MIN_COMMIT_TRUEUP:** compares total usage charges vs minimum commit; charges the greater of the two
   - **CUSTOM_INVOICE_ONLY:** generates a draft invoice for manual review
4. Writes ledger entries for all invoice line items
5. Invoice is marked `issued` and optionally exported to external accounting systems

---

## Entitlement Resolution Algorithm

### Query Behaviour

```
resolveEntitlements(appId, teamId, atTime) -> EntitlementResult
```

1. Look up the team's `BillingEntity`
2. Check for an `ACTIVE` contract on that billing entity
3. **If active contract exists:** resolve via enterprise path (bundle + overrides), set `billingMode: ENTERPRISE_CONTRACT`
4. **If no active contract:** resolve via per-app subscription plan, set `billingMode` to `subscription` | `wallet` | `hybrid`

### Priority Cascade (Highest Wins)

| Priority | Source | Description |
|----------|--------|-------------|
| 1 (highest) | **ContractOverride** | Per-app + per-meter overrides on the enterprise contract |
| 2 | **BundleMeterPolicy** | Default policies from the contract's bundle |
| 3 | **Per-App Subscription Plan** | Standard plan entitlements (used when no enterprise contract exists) |
| 4 (lowest) | **Defaults** | System-wide fallback defaults |

### Result Object

The resolved entitlement per app contains:

- Features enabled (boolean flags)
- Meter policies per meter: `limitType`, `includedAmount`, `enforcement`, `overageBilling`
- Billing mode: `ENTERPRISE_CONTRACT` | `subscription` | `wallet` | `hybrid`
- `billable` flags (for UI labelling; enforcement is always server-side)

### Enterprise Defaults

- **Enforcement:** `SOFT` by default (warn only), unless the contract explicitly specifies `HARD`
- **Unlimited meters:** COGS billables are **always** computed, even when customer billing is zero. Customer billables are generated as zero-amount lines (or usage summaries) depending on contract policy.
- **Invoice granularity:** one base fee line, optional per-app true-up lines, attached usage summary JSONB for audit

### V1 Contract Rules

- A team with **0 active contracts** uses normal per-app subscriptions
- A team with **1 active contract** enters enterprise mode; per-app subscriptions are generally disabled
- Enforced by unique partial index: `(billToId) WHERE status = 'ACTIVE'`

---

## Security & Hard Edges

- **No Stripe keys in JWTs.** Store encrypted on the Billing service side.
- **All money/usage endpoints must be idempotent.**
- **Stripe webhooks are at-least-once** — duplicates and out-of-order events will occur. Store `event.id` and ignore repeats.
- **Decimal-safe money** — store all amounts as integer minor units (pence/cents).
- **Timezones** — UTC everywhere. Billing periods derived from Stripe subscription period timestamps.
- **Pricing changes** — require effective dating; billable line items snapshot their inputs.
- **Ledger integrity** — use DB transactions. Consider `SERIALIZABLE` isolation or per-team advisory locks for balance-affecting operations.
