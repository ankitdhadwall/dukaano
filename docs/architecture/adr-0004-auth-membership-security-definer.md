# ADR-0004 — A `SECURITY DEFINER` function for the pre-tenant login lookup

**Status:** Accepted · **Date:** 2026-08-16 · **Blueprint:** silent

## Context

Login has a bootstrapping problem that the blueprint's tenancy model does not address.

Row-level security scopes every query on `shop_membership` to `current_setting('app.shop_id')`.
But at login time there is no shop id yet — finding out which shops this user belongs to *is* the
purpose of the query. The lookup must read across tenants, once, before a tenant context can exist.

The symptom was concrete: login returned 403 and `/v1/auth/me` returned 403. RLS was working
exactly as designed and blocking a read that legitimately needs to cross tenants.

Three ways out, in increasing order of blast radius:

1. Grant `BYPASSRLS` to `dukaano_app` — every query in the application escapes RLS, forever, to
   solve one query. This also directly contradicts [ADR-0002](adr-0002-no-force-row-level-security.md),
   whose boot assertion would refuse to start.
2. Add an RLS policy permitting `shop_membership` reads when `app.shop_id` is unset — turns the
   *absence* of a tenant context into a permission. Any code path that forgets to set the context
   then quietly reads every shop's memberships instead of failing. RLS must fail closed.
3. Narrow the bypass to exactly the one query that needs it.

## Decision

Option 3, as a `SECURITY DEFINER` function:

```sql
CREATE FUNCTION auth_active_memberships(p_user_id uuid)
RETURNS TABLE (...)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ... FROM shop_membership m JOIN shop s ON s.id = m.shop_id
  WHERE m.user_id = p_user_id AND m.status = 'ACTIVE' AND s.status <> 'DELETED'
$$;
```

It runs as its owner, so RLS does not apply to its body. The bypass is bounded by the function's
own text: one user id in, that user's active memberships out. There is no parameter that widens
it, and no way to reach any other table through it.

`SET search_path = public, pg_temp` is mandatory, not stylistic. Without it, a caller who can
create objects in a schema earlier on their search path can shadow `shop_membership` with their own
table and have the function read it with the owner's privileges. This is the standard
`SECURITY DEFINER` escalation and the `SET` clause is the standard defence.

`EXECUTE` is granted to `dukaano_app` and to nobody else.

## Consequences

**Good.** The RLS bypass is one function with a fixed body, reviewable in ten lines, instead of a
role-wide capability. `SELECT * FROM shop_membership` from application code still returns zero rows
without a tenant context — RLS keeps failing closed everywhere it should.

**Good.** It is the narrowest option available and the only one that survives ADR-0002's boot
assertion unchanged.

**Bad.** The function is a privileged object living in the migration history rather than in
application code, so it is easy to miss in review. Anyone editing it must re-derive the
`search_path` reasoning. A comment in the migration says so; that is weaker than a lint rule, and
no lint rule can reach into SQL.

**Bad.** It sets a precedent. The next "just one query needs to cross tenants" will point at this
ADR as prior art. The bar for the next one: a genuine bootstrapping need where no tenant context
*can* exist yet, not merely a query that is inconvenient to scope. Support tooling and analytics do
not qualify — those get an explicitly cross-tenant role with its own audit trail.

## Related

- [ADR-0002](adr-0002-no-force-row-level-security.md) — why `dukaano_app` is `NOBYPASSRLS`, which
  is what makes this function necessary rather than optional.
