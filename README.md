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

**Phase 0 — Product Definition.** No application code yet.

👉 **[Read the Product & Engineering Blueprint](docs/dukaano-blueprint.md)** — the full product
definition, architecture, data model, sync design, edge-case analysis, test strategy and phase plan.
It is awaiting approval; sections marked **DECISION** become binding on approval, and later changes
require an ADR in `docs/architecture/`.

Open questions that block Phase 1 are in
[§31 of the blueprint](docs/dukaano-blueprint.md#31-blocking-questions-and-assumptions).

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
