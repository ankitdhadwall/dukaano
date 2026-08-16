# Dukaano

**Billing, Stock aur Khata — Sab Ek Jagah**

A bilingual (Hindi/English), offline-first operating system for small Indian retail shops.
Replaces the bill book, the stock register and the udhaar khata with one system that works on a
budget Android phone with unreliable connectivity.

| Product | Surface | Primary user |
|---|---|---|
| **Dukaano Mobile** | React Native + Expo (Android-first) | Owner, Cashier — fast offline billing |
| **Dukaano Business** | Next.js web admin | Owner, Manager — bulk entry, reports, settings |
| **Dukaano Admin** | Next.js super admin | Platform team — tenants, plans, catalogue, health |

## Status

**Phase 3 complete — Sync engine.** The API is real: multi-tenant, RLS-enforced, audit-logged,
offline-capable, and seeded with a working general store. No web or mobile client yet.

| Phase | Scope | State |
|---|---|---|
| 0 | Product definition | ✅ [Blueprint](docs/dukaano-blueprint.md) approved |
| 1 | Foundation — auth, tenancy, RBAC, money | ✅ [Status](docs/phase-1-status.md) |
| 2 | Catalogue, inventory, import | ✅ [Status](docs/phase-2-status.md) — 4 of 4 criteria |
| 3 | Offline sync engine | ✅ [Status](docs/phase-3-status.md) — 4 of 4 criteria |
| 4 | Billing & payments | ⬜ Next |

**773 tests.** `@dukaano/money` and `@dukaano/business-logic` hold 100% branch coverage — they
carry the rules where a silent bug is most expensive.

👉 **[Read the Product & Engineering Blueprint](docs/dukaano-blueprint.md)** — the full product
definition, architecture, data model, sync design, edge-case analysis, test strategy and phase
plan. Sections marked **DECISION** are binding; changing one requires an ADR in
[`docs/architecture/`](docs/architecture/).

## Running it

```bash
pnpm install
pnpm db:up                                    # Postgres 16 on :5433, Redis on :6380
cd apps/api && pnpm exec prisma migrate deploy && pnpm exec prisma generate
pnpm db:seed                                  # Dhadwal Confectionery & General Store
pnpm dev
```

The API refuses to start if `DATABASE_URL` points at a role that can bypass row-level security.
That is deliberate — see [ADR-0002](docs/architecture/adr-0002-no-force-row-level-security.md).

## Documentation map

| Path | Contents |
|---|---|
| `docs/dukaano-blueprint.md` | The blueprint (this is the contract) |
| `docs/architecture/` | ADRs — one per binding decision |
| `docs/api/` | OpenAPI spec and API guides |
| `docs/database/` | ERD, migration notes, index rationale |
| `docs/sync/` | Offline sync protocol, conflict matrix, failure runbook |
| `docs/deployment/` | Runbooks, restore drill procedure |
| `docs/qa/` | Manual test plans, release checklist |
