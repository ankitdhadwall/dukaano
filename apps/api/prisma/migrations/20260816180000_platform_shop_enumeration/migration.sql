-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Platform shop enumeration for scheduled maintenance jobs
--
-- The nightly reconciliation sweep (blueprint §17.4) must visit every shop, but `shop` carries
-- the same RLS policy as every tenant table — `id = current_setting('app.shop_id')` — so the
-- application role cannot list shops at all. It sees exactly the one shop the current request is
-- scoped to, which is correct for requests and useless for a platform sweep.
--
-- The same three options as the login lookup (see the auth_active_memberships migration and
-- ADR-0004), and the same answer: narrow the bypass to precisely the query that needs it rather
-- than granting BYPASSRLS or weakening the policy.
--
-- WHAT THIS FUNCTION CAN AND CANNOT REACH
--
-- It reads `shop` and nothing else, and returns only identity columns — id, name, status. There
-- is no product, sale, customer, payment or ledger data on any path through it, and no parameter
-- that could widen it. The sweep uses the ids it returns to open a normal tenant-scoped
-- transaction per shop, so every actual data read still passes through RLS unchanged. This is a
-- directory, not a back door.
--
-- `SET search_path = public, pg_temp` is mandatory, not stylistic: without it a role able to
-- create objects earlier on its search path could shadow `shop` with its own table and have this
-- function read it with the owner's privileges.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION platform_shop_directory()
RETURNS TABLE (id uuid, name text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.name, s.status
  FROM shop s
  -- A deleted shop's data is retained for the 30-day recovery window (§27.4) but is not worth
  -- reconciling: nobody is writing to it, and a finding on it cannot be acted on.
  WHERE s.status <> 'DELETED'
    AND s.archived_at IS NULL
  ORDER BY s.created_at
$$;

REVOKE ALL ON FUNCTION platform_shop_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_shop_directory() TO dukaano_app;
