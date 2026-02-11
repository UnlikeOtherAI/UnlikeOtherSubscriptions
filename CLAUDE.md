# CLAUDE.md — Project Rules & Standards

This file is the **source of truth** for all development on UnlikeOtherSubscriptions. Every contributor and AI agent must follow these rules.

---

## Code Architecture

- **All files must be kept under 500 lines of code.** If a file approaches this limit, it must be split into smaller, focused modules.
- Files must be organised into **functional components** — each file should have a single, clear responsibility.
- **No file should contain multiple classes.** One class per file, named to match the class it exports.
- Shared utilities, types, and constants should live in dedicated modules, not be inlined into business logic.
- Follow a clean separation of concerns: routes, controllers, services, repositories, models, and workers should each live in their own directories.

## Breaking Changes & Releases

- **All breaking changes must be carefully managed.** Good architecture must be maintained at all times — never merge a breaking change without a migration path or deprecation notice.
- **Every release must be published as an official GitHub Release**, tagged with a semantic version (e.g. `v1.0.0`, `v1.1.0`, `v2.0.0-beta.1`).
- Use `gh release create` with proper release notes describing what changed, what broke (if anything), and how to migrate.
- Tags must follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

## API Compatibility Contract

This service is the **billing backbone for many services** and must be treated as a public API with a must-not-break contract.

### Versioning

- Major versions live in the URL path: `/v1/...`, `/v2/...`
- **Never** ship silent breaking changes inside a major version
- Minor/patch changes are **additive only**

### What's Allowed in v1 (Backwards-Compatible)

- Add new endpoints, optional request/response fields, new enum values, new event types
- Loosen validation (accept more inputs)

### What's Forbidden in v1 (Breaking)

- Remove or rename fields
- Make optional fields required
- Change field type, units, or meaning
- Change default behaviour affecting billing/entitlements
- Narrow validation (reject inputs that previously passed)

### Event Schema Versioning

- Usage event payloads are versioned via `eventType`: `llm.tokens.v1`, `llm.image.v1`, etc.
- The billing service must validate payloads against registered schemas
- The pricing engine must price multiple schema versions in parallel during migration windows

### CI Enforcement (Non-Negotiable)

- **OpenAPI spec per version** stored in repo: `openapi/v1.yaml`
- CI must run a "no breaking changes" diff on every PR against the previous release
- Usage event JSON Schemas must be checked for backwards compatibility
- **Contract tests** with golden fixtures for key endpoints and webhook handlers
- **If CI detects a breaking change without `/v2`, the build must fail**

### Deprecation Policy

- Ship `/v2` alongside `/v1` (both run concurrently)
- Announce end-of-life for old version (12-24 months for external clients)
- Emit `Deprecation` and `Sunset` HTTP headers
- Provide migration guide + SDK support for both versions

## Security

**It is of the utmost importance to maintain security at all times.**

- Any potential security issue **must be addressed and mitigated immediately** — never defer or ignore a security concern.
- Never commit secrets, API keys, credentials, or tokens to the repository. Use environment variables, Vault, or KMS.
- All inputs must be validated at system boundaries (user input, external APIs, webhook payloads).
- Stripe webhook signatures must always be verified. JWT tokens must always be validated.
- Dependencies must be kept up to date. Known vulnerabilities in dependencies must be patched promptly.
- Follow the OWASP Top 10 — guard against injection, XSS, CSRF, broken auth, and all other common vulnerability classes.
- All money operations must be idempotent and use integer minor units (pence/cents) to avoid floating-point errors.
- Ledger entries are append-only — never update or delete financial records.

## Documentation

- The README must contain information on **what the project is** and **how to use it**.
- Architecture decisions should be documented in `docs/`.
- API contracts and data models must be kept in sync with the codebase.

## General Standards

- Write clean, readable TypeScript with proper type safety.
- Use Zod for runtime validation at API boundaries.
- Structured logging (Pino) with correlation IDs on every request.
- All database operations that affect financial state must use transactions.
- Tests are required for critical paths: billing, ledger, entitlements, and Stripe webhook handling.
