# UnlikeOtherSubscriptions

A centralised **Billing & Usage Ledger Service** for the [UnlikeOtherAI](https://github.com/UnlikeOtherAI) ecosystem. One service handles subscriptions, usage-based charges, entitlements, and financial ledger tracking across all products and teams.

## What It Does

- **Stripe Subscriptions** — plans, seats, add-ons per Team
- **Usage-Based Billing** — storage (GB-month), bandwidth, LLM tokens, image generation
- **Append-Only Ledger** — every financial change is an immutable ledger entry
- **Entitlements & Limits** — real-time feature gating for any connected tool
- **Enterprise Contracts** — bundles, rate cards, unlimited tariffs, and true-up invoicing
- **COGS Tracking** — know what you pay providers vs what you charge customers

## Architecture

- **Runtime:** Node.js + Fastify
- **Database:** PostgreSQL + Prisma ORM
- **Payments:** Stripe (subscriptions, checkout, webhooks)
- **Queue:** pg-boss (Postgres-backed)
- **Validation:** Zod
- **Logging:** Pino (structured JSON)

See [`docs/brief.md`](docs/brief.md) for the project brief and [`docs/architecture.md`](docs/architecture.md) for the full technical architecture.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **App** | A tool/product in the ecosystem (e.g. ReceiptsInOrder) |
| **Team** | The billing entity — every user has a Personal Team by default |
| **Bundle** | A named set of apps with entitlement defaults |
| **Contract** | An enterprise commercial agreement with custom pricing |
| **BillingEntity** | The "who pays" abstraction (V1: Team, future: Org) |

## Billing Modes

1. **Subscription-First** — Stripe subscription per Team with seats and add-ons
2. **Wallet / Micropayments** — prepaid credit balance with auto-top-up
3. **Enterprise Contract** — fixed fee, included allowances, true-up, or minimum commit

## Integration

Every tool integrates via a shared TypeScript SDK:

```ts
import { createBillingClient } from '@unlikeotherai/billing-sdk';

// appId is configured once at client creation — included automatically in JWTs and API paths
const billingClient = createBillingClient({
  appId: 'app_myTool',
  secret: process.env.BILLING_SECRET!,
  baseUrl: process.env.BILLING_URL!,
});

// Report usage
await billingClient.reportUsage([
  {
    idempotencyKey: 'evt_abc123',
    eventType: 'llm.tokens.v1',
    timestamp: new Date().toISOString(),
    teamId: 'team_xyz',
    payload: { provider: 'openai', model: 'gpt-5', inputTokens: 1200, outputTokens: 350 },
    source: 'my-tool/1.0.0',
  },
]);

// Check entitlements
const entitlements = await billingClient.getEntitlements('team_xyz');

// Create checkout
const { url } = await billingClient.createCheckout('team_xyz', { planCode: 'pro' });
```

## API Authentication

All API endpoints (except Stripe webhooks) require a signed JWT:

- Each App has a shared HMAC secret with the billing service
- JWTs include `appId`, `teamId`, scopes, and a short TTL (60–300s)
- Stripe webhooks are verified via Stripe signature, not JWT

## Development

```bash
# Install dependencies
npm install

# Validate the Prisma schema
npx prisma validate

# Generate Prisma Client
npx prisma generate

# Run database migrations
npx prisma migrate dev

# Start the service
npm run dev
```

> **Note:** The Prisma schema is split into modules under `prisma/schema/` for maintainability. Schema discovery is configured centrally via the `"prisma"` key in `package.json`, so all `npx prisma` commands work from the project root without extra flags.

## Releases

All releases are published as official GitHub Releases with semantic version tags (`v1.0.0`). See [Releases](https://github.com/UnlikeOtherAI/UnlikeOtherSubscriptions/releases).

## Documentation

- [`docs/brief.md`](docs/brief.md) — Project brief, core concepts, delivery plan
- [`docs/architecture.md`](docs/architecture.md) — Data model, API surface, workflows, security
- [`CLAUDE.md`](CLAUDE.md) — Development rules and standards

## License

Proprietary. All rights reserved.
