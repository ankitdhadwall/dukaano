# Phase 1 — Foundation · **Complete**

Last updated: 2026-08-16 · Blueprint: [dukaano-blueprint.md](dukaano-blueprint.md) §28

## Acceptance criteria — all met

| # | Criterion (blueprint §28) | Evidence |
|---|---|---|
| 1 | `@dukaano/money` at 100% coverage | 253 tests · 100% statements/branches/functions/lines, enforced as a hard CI gate |
| 2 | Two shops cannot see each other | 9 integration tests in `test/tenant-isolation.spec.ts`, **generated from the route table** |
| 3 | Permission matrix tested per route | 26 integration tests in `test/authorization.spec.ts`, all three roles × every protected route |
| 4 | Boots in both locales | `GET /health/locales` renders hi + en, incl. CLDR plurals; 36 i18n tests with a parity CI gate |

**456 tests across 6 packages. Lint, typecheck and build clean.**

| Package | Tests | Coverage gate |
|---|--:|---|
| `@dukaano/money` | 253 | **100%** (hard) |
| `@dukaano/business-logic` | 74 | **100%** (hard) |
| `@dukaano/i18n` | 36 | 95% |
| `@dukaano/validation` | 33 | 90% |
| `@dukaano/types` | 15 | 90% |
| `@dukaano/api` | 45 | integration |

## Verified behaviour, not just written code

**Tenant isolation.** Shop A requests Shop B's row by primary key → **0 rows** at the database
layer, **404** through the API (never 403 — a 403 confirms existence and enables id enumeration).
No tenant context at all → 0 rows; the policy fails closed. A tampered `shopId` claim → 401. A
cross-tenant write that returns 404 leaves the victim genuinely unmodified.

**The route-table gates.** Two CI checks read Nest's own route metadata (not Express internals, so
they survive framework upgrades):
- every parameterised route must have a tenant-isolation attack in the matrix, and
- every route must declare `@Public()` or `@RequirePermission()` — authorization is default-deny.

A new endpoint that forgets either one fails the build the day it is written.

**The RLS role assertion.** Pointed at the owner role, the API exits 1:

> `Refusing to start: Database role "dukaano" is a superuser and holds BYPASSRLS and owns the tables (RLS policies do not apply to the owner). Tenant isolation (blueprint §13) would not be enforced.`

**Integrity constraints.** The database rejects a bill where `subtotal − discount + rounding ≠ total`,
an udhaar sale with no customer, a `DAMAGE` movement with no reason, a product with no name in
either language, and a negative payment amount.

**Session security.** Refresh rotation with reuse detection: replaying a rotated token revokes the
whole family, including the successor the honest party holds.

## Deviations from the blueprint — all deliberate, all recorded

| Blueprint said | Built | Why |
|---|---|---|
| Rounding "half-up" (§15.1) | Half **away from zero** | §15.1 assumed non-negative quantities. Returns and refunds are signed, and only the symmetric variant makes a cancellation reverse to *exactly* zero; otherwise one-paisa residues accumulate in the khata untraceably. |
| `FORCE ROW LEVEL SECURITY` (§13) | `ENABLE` + a boot-time role assertion | FORCE applies RLS to the table *owner*; the app connects as a non-owner, so ENABLE already covers it, while FORCE would break owner-run migrations and seeds. The assertion catches the same misconfiguration and **fails loudly** instead of silently filtering. |
| Jest + Testcontainers (§26.1) | Vitest + a CI Postgres service | Same guarantee — a real, isolated Postgres — with one test runner instead of two and no container startup per local run. |
| — | `auth_active_memberships()`, a `SECURITY DEFINER` function | Login must read RLS-protected `shop_membership` *before* any tenant context exists. Rather than dropping RLS from the staff roster or granting BYPASSRLS, the bypass is narrowed to one auditable query shape, parameterised on user id alone. |
| `eslint-plugin-boundaries` (§29) | `no-restricted-imports` patterns | Same enforcement, one fewer dependency. |

Each of these needs an ADR in `docs/architecture/`. **Not yet written — first task of Phase 2.**

## Three bugs the build caught, worth remembering

1. **Prisma + SWC.** `class PrismaService extends PrismaClient` works under `tsc` but loses Prisma's
   model delegates under SWC's class-field semantics — production fine, tests `undefined`.
   Now composition.
2. **Hoisted imports in the test harness.** `env.ts` validates at module load; a static
   `import { AppModule }` evaluated it *before* the harness pointed it at the test database, so the
   suite silently ran against **development**. Now a dynamic import plus an assertion on
   `current_database()`.
3. **Dual `zod` instances.** `instanceof ZodError` is false across two pnpm-resolved copies, so every
   validation error became a 500. Now detected structurally.

## Local development

```bash
pnpm install
pnpm db:up                                     # Postgres 16 :5433, Redis :6380
cd apps/api && pnpm exec prisma migrate deploy
pnpm exec prisma generate
pnpm test                                      # 456 tests
```

The API must connect as `dukaano_app` (non-owner, `NOBYPASSRLS`). Pointing `DATABASE_URL` at the
owner is refused at boot, by design.

## Not built in Phase 1 (deferred, not forgotten)

- ADRs for the five deviations above
- Seed script (plans, master catalogue, demo shop) — `pnpm db:seed` is wired but has no `seed.ts`
- Structured request logging (`nestjs-pino` is installed but not mounted) and Sentry
- Redis is running but nothing uses it yet; BullMQ arrives with messaging in Phase 6

## Next: Phase 2 — Catalogue & Inventory

Products with bilingual names and aliases, categories, units, the master-catalogue adoption flow,
append-only inventory transactions with moving-average costing, low-stock thresholds, the bulk
entry grid and CSV/XLSX import.

Acceptance criteria: product search under 100 ms at 5,000 products · every stock change has a
transaction row · a 5,000-row import with a per-row error report · `balance == Σ transactions`
verified by the reconciliation job.
