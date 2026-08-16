# ADR-0002 — No `FORCE ROW LEVEL SECURITY`; a boot-time role assertion instead

**Status:** Accepted · **Date:** 2026-08-16 · **Refines:** Blueprint §23.3

## Context

Blueprint §23.3 requires `ALTER TABLE … FORCE ROW LEVEL SECURITY` on every tenant table, on top of
`ENABLE`. The distinction matters: `ENABLE` applies policies to everyone *except* the table's owner
and superusers; `FORCE` applies them to the owner as well.

The intent is right — the danger is a connection that quietly bypasses RLS and reads every shop's
data. But `FORCE` addresses that danger in the wrong place, and it breaks the tools we need:

- **Migrations run as the owner.** Under `FORCE`, a migration that backfills a column sees zero
  rows, because no `app.shop_id` is set. It does not fail. It reports success having updated
  nothing. That is the worst failure mode available: a silent, believable no-op.
- **`prisma db seed` and `prisma migrate` both connect as the owner.** Both would need a tenant
  context they have no business having.
- **Support and backup tooling** operate cross-tenant by definition.

More fundamentally, `FORCE` only protects against the owner role reaching production. It does
nothing about a superuser connection, a role with `BYPASSRLS`, or a `DATABASE_URL` pointed at the
wrong role — and those are the realistic incidents. `FORCE` reads as a safety net while leaving
the actual hole open.

## Decision

Two mechanisms replace it.

**1. A dedicated application role.** Migrations create `dukaano_app`: not the owner of any table,
`NOBYPASSRLS`, and granted only `SELECT`/`INSERT`/`UPDATE` on tenant tables, with `DELETE` on a
four-table allowlist. RLS `ENABLE` alone is sufficient for a non-owner, so the migration path
stays fully functional as owner while the application cannot escape its tenant.

**2. A boot-time assertion.** `PrismaService.assertRoleCannotBypassRls()` runs before the app
accepts traffic and queries the connected role's actual privileges:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
-- and: does current_user own any table that has RLS enabled?
```

If the role is a superuser, holds `BYPASSRLS`, or owns an RLS-enabled table, the process
**exits non-zero**. It does not warn and continue.

This inverts the failure mode. Under `FORCE`, a misconfiguration produces empty results that look
like an empty database. Under the assertion, a misconfiguration produces a dead process and a
loud log line — which is the correct thing for a tenancy boundary to do.

## Consequences

**Good.** Covers the whole class of bypass, not just the owner case. The check runs against live
`pg_roles` state, so it catches a role whose privileges were changed after deployment, which no
amount of migration SQL can. Migrations and seeds work normally.

**Good.** It is directly testable, and is tested: pointing `DATABASE_URL` at the owner role and
asserting exit code 1 is a real test, where "`FORCE` is set on 24 tables" is only a schema
assertion that proves nothing about runtime.

**Bad.** The protection now lives in application code rather than in the database. A second
consumer of this database — a future analytics service, a Metabase instance — does not inherit it
and must run its own check. This is written into the ops runbook, but a runbook is weaker than a
constraint, and it is a real cost.

**Bad.** The assertion adds a round-trip to boot and a hard dependency on Postgres being reachable
at startup. Acceptable: the app is useless without its database anyway.

## Revisit if

We add a second service connecting to this database. At that point the cheapest fix may be to
enable `FORCE` *and* keep the assertion, moving migrations to a role that is explicitly exempted —
paying the migration-tooling cost once, in exchange for defence that travels with the data.
