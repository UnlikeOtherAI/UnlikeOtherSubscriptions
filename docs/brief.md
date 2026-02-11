# UnlikeOtherSubscriptions — Project Brief

## Overview

UnlikeOtherSubscriptions is a centralised **Billing & Usage** service designed to be consumed by all tools and products in the UnlikeOtherAI ecosystem. It handles subscription management, usage-based charging, entitlement gating, and financial ledger tracking across multiple products and teams.

## Problem Statement

Each tool in the ecosystem (ReceiptsInOrder, POSimulator, etc.) needs billing, usage tracking, and entitlement enforcement. Building these independently per tool leads to duplicated logic, inconsistent billing, and integration sprawl. A single shared service eliminates this.

## What This Service Does

- Manages **Stripe subscriptions** (plans, seats, add-ons)
- Manages **usage-based charges** (storage, bandwidth, LLM tokens, image generation)
- Maintains an **append-only financial ledger** per Team
- Exposes **entitlements and limits** so each tool can gate features
- Computes **COGS** (provider costs) vs **customer charges** for margin visibility

## What This Service Does Not Do (Initially)

- Automatically ingest usage metrics from cloud providers (AWS/DO) — tools instrument usage themselves
- Act as a general analytics platform — only billing-grade aggregates and reporting views

## Core Concepts

### Tenancy

| Concept | Description |
|---------|-------------|
| **App** | A tool or product in the ecosystem (e.g. ReceiptsInOrder) |
| **Team** | The billing entity / workspace — all billing happens here |
| **User** | A member of a Team, used for usage attribution |
| **Bundle** | A named set of Apps with entitlement defaults (e.g. `BUNDLE_ALL_APPS_ENTERPRISE`) |
| **Contract** | An enterprise commercial agreement for a Team defining bundles, pricing, and invoice terms |
| **BillingEntity** | The "who pays" abstraction — V1: always a Team. Future: may be an Org/Group of Teams |

Billing is always at the **Team** level. Usage events may optionally include a `userId` for internal attribution. Team IDs are **global across apps** in the billing service; if apps have their own team records, an `ExternalTeamRef` mapping layer resolves them to a single billing Team.

### V1 Scoping Decision — Single-Team Contracts

**V1:** `Contract.billToId` references a single Team (via `BillingEntity`). At most **one active contract per team** (enforced by a unique partial index). No "group of teams" yet.

**Future-proofing:** all "who pays" references use `billToId` (not `teamId`) on `Contract`, `Invoice`, and `LedgerEntry`. When Orgs arrive, a new `BillingEntity(type=ORG)` is created and `billToId` points to it — no schema rewrite needed. Usage always stays at Team level for enforcement and per-team reporting; org-level views are derived by summing.

### V1 Rule — Personal Teams (Single-User Default)

All billing and entitlements are **Team-scoped**. There is no "user-only billing entity". Every user must belong to at least one Team.

On **user signup/creation**, the system **automatically creates a Personal Team** for that user:

- `Team.kind = PERSONAL`
- The user is added as `OWNER`
- This Personal Team is the default selected workspace in the UI
- Individual subscriptions are simply **subscriptions on the Personal Team** (seats = 1)

Enforcement is **server-side** (not just a frontend concern):

- **One Personal Team per user** — enforced by DB constraint: unique `(ownerUserId) WHERE kind = 'PERSONAL'`
- Any request requiring billing context **must** include `teamId` — the UI may hide this by auto-selecting the Personal Team, but the backend must guarantee it exists
- When ingesting usage events, if a tool provides `userId` but no `teamId`, the billing service **resolves** `teamId = personalTeam(userId)` rather than rejecting (reduces integration errors)

Personal Teams can later be upgraded to enterprise contracts or the user can create a separate Team and switch. Default name: `"Personal"` or `"<FirstName>'s workspace"`.

### Money Model — Ledger First

All financial state is derived from an **append-only ledger**. Entries are never updated or deleted; corrections are made via reversal or adjustment entries. This supports prepaid credits, postpaid invoicing, refunds, disputes, and full auditability.

### Usage Model — Raw Events + Billable Aggregates

Raw `UsageEvent` records are immutable inputs. A pricing engine transforms them into `BillableLineItem` records using versioned price rules effective at the event timestamp.

## Billing Modes

Each App (or Team+App combination) can operate in one of two modes:

### Subscription-First (Option A)

Stripe subscription per Team with a base plan, per-seat pricing, and add-ons. Usage is tracked for quota enforcement and overage billing. Best for **predictable recurring revenue**.

### Wallet / Micropayments-First (Option B)

Teams hold a prepaid credit balance. Usage events create debit ledger entries (immediately or in daily batches). The wallet auto-tops-up via Stripe when the balance drops below a threshold. Best for **heavy variable costs** such as LLM usage.

Both modes can coexist simultaneously across different Apps or Teams.

### Enterprise Contract (Option C)

A contract layer sits **above** per-app plans for multi-app enterprise deals. A Contract defines:

- Which **Bundle(s)** of apps the Team has access to
- Pricing model: `FIXED`, `FIXED_PLUS_TRUEUP`, `MIN_COMMIT_TRUEUP`, or `CUSTOM_INVOICE_ONLY`
- Invoice terms: billing period (monthly/quarterly), payment terms (net 30), PO numbers, billing contacts
- Per-app/meter overrides (including "unlimited")

Usage is still tracked per app identically to other modes — this ensures COGS visibility, enterprise transparency, and renegotiation leverage even when a meter is marked unlimited.

**V1 contract rules:**
- A team with **0 active contracts** uses normal per-app subscriptions
- A team with **1 active contract** enters enterprise mode (bundle + rate card); per-app subscriptions are generally disabled
- "Unlimited" never means "don't record" — `UsageEvent` and internal COGS billables are always created

#### Enterprise Billing Patterns

| Pattern | How It Works |
|---------|--------------|
| **Fixed "Unlimited Everything"** | Single base fee line item. Usage summary at no charge for reporting only. |
| **Included Allowance + True-Up** | Base fee includes quotas (e.g. 10M tokens, 2TB egress). Overage billed as true-up line items. |
| **Minimum Commit + True-Up** | Monthly/quarterly minimum spend. If usage < minimum, charge minimum. If usage > minimum, bill overage. |

#### Meter Limit Policies

Rather than encoding "unlimited" as a large number, each meter has explicit policy fields:

| Field | Values | Purpose |
|-------|--------|---------|
| `limitType` | `NONE`, `INCLUDED`, `UNLIMITED`, `HARD_CAP` | What kind of limit applies |
| `includedAmount` | integer | Quota amount (only when `INCLUDED`) |
| `overageBilling` | `NONE`, `PER_UNIT`, `TIERED`, `CUSTOM` | How overage is charged |
| `enforcement` | `NONE`, `SOFT`, `HARD` | Whether to warn or block (enterprise defaults to `SOFT`) |
| `reporting` | always on | Usage is always tracked regardless of limit type |

## Usage Meters

The service tracks four categories of usage via a provider/model-agnostic meter catalogue:

| Category | Type | Unit | Example Attributes |
|----------|------|------|--------------------|
| **Storage** | Gauge | Bytes | `bytesUsed` (sampled, billed as GB-month) |
| **Bandwidth** | Counter | Bytes | `bytesIn`, `bytesOut`, traffic class |
| **LLM Tokens** | Counter | Tokens | `inputTokens`, `outputTokens`, `cachedTokens`, provider, model |
| **LLM Images** | Counter | Images | `width`, `height`, `count`, provider, model |

## API Stability & Versioning Policy

This service is treated as a **public API with a compatibility contract**, even for internal consumers. Breaking existing clients is never acceptable within a major version.

### Versioning

- **Major versions in the URL:** `/v1/...`, `/v2/...`
- Minor/patch changes are **additive only** — no behaviour changes that break clients
- If an existing client can't keep working without code changes, it requires a **new major version**

### Backwards-Compatible Changes (Allowed in v1)

- Add new endpoints
- Add **optional** request fields (with defaults)
- Add **optional** response fields
- Add new enum values (clients must treat enums as open-ended)
- Loosen validation (accept more inputs)
- Add new event types

### Breaking Changes (Not Allowed in v1)

- Remove or rename fields
- Make an optional field required
- Change field type, units, or meaning
- Change default behaviour that affects billing/entitlements for existing clients
- Narrow validation (reject inputs that used to pass)

### Client Rule

**Tolerant reader** — all clients must ignore unknown fields and unknown enum values.

### Deprecation Policy

When a breaking change is required: ship `/v2` alongside `/v1` (both run concurrently), announce an end-of-life date for `/v1` (12-24 months for external clients), emit `Deprecation` and `Sunset` HTTP headers, and provide a migration guide with SDK support for both versions.

### SDK Versioning

The official TypeScript SDK is pinned to the major API version: `@unlikeotherai/billing-sdk@1.x` talks to `/v1`.

## Canonical Event Contract

Every tool integrates via a shared TypeScript SDK and a single event shape:

| Field | Required | Description |
|-------|----------|-------------|
| `idempotencyKey` | Yes | Deduplication key (unique per App) |
| `eventType` | Yes | Versioned namespaced string (e.g. `llm.tokens.v1`, `storage.sample.v1`) |
| `timestamp` | Yes | Event time (UTC) |
| `teamId` | Conditional | Owning team. Required unless `userId` is provided, in which case the server resolves `teamId` from the user's Personal Team. |
| `userId` | No | Acting user (for attribution). If provided without `teamId`, the server resolves `teamId = personalTeam(userId)`. |
| `payload` | Yes | JSONB — validated against the schema for the event type version |
| `source` | Yes | Service name and version |

> **Note:** `billToId` is **not** client-provided. The server resolves it from `teamId` at ingestion time (via the Team's `BillingEntity`). It appears on the stored `UsageEvent` record but is never part of the client-facing contract.

### Event Schema Versioning

Usage event payloads are JSONB and will evolve. Versions are embedded in `eventType`:

- `llm.tokens.v1` — current token usage schema
- `llm.image.v1` — current image generation schema
- `storage.sample.v1`, `bandwidth.sample.v1`

The billing service validates each payload against its registered schema version. The pricing engine must be able to price multiple schema versions in parallel during migration windows.

## Shared Client SDK

A lightweight TypeScript SDK consumed by every tool:

```ts
// appId is configured once when creating the client instance:
// const billingClient = createBillingClient({ appId, secret, baseUrl })

billingClient.reportUsage(events[])
billingClient.getEntitlements(teamId)
billingClient.createCheckout(teamId, options)
```

> **Note:** `appId` is not passed per-call. It is set once in the SDK client configuration and included automatically in JWTs and API paths.

This prevents each tool from inventing its own integration.

## Delivery Plan

| Phase | Scope | Estimate |
|-------|-------|----------|
| **1 — MVP Billing Spine** | Apps, Teams, Users, JWT auth, Stripe checkout, webhooks, entitlements | 1–2 weeks |
| **2 — Usage Ingestion + Pricing** | UsageEvent ingestion, pricing rules, BillableLineItems, usage-aware entitlements | 1–2 weeks |
| **3 — Wallet / Micropayments** | Ledger accounts, top-up flow, immediate usage debits, balance endpoint | 1–2 weeks |
| **4 — Storage & Bandwidth Billing** | Gauge integration (GB-month), bandwidth counters, period close jobs | 1–2 weeks |
| **5 — Enterprise Contracts + Bundles** | Bundle/Contract models, meter policies, entitlement merge, contract rate cards, enterprise invoice generation | 1–2 weeks |
| **6 — Multi-App Polish** | Admin UI (Vite), manual adjustments, pricing editor, webhook replay tooling | Ongoing |
