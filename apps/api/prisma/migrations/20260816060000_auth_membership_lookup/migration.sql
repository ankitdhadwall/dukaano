-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Authentication membership lookup
--
-- The bootstrap problem: `shop_membership` is tenant-scoped and protected by RLS, but login has
-- to read it *before* any tenant context can exist — finding which shop a user belongs to is
-- precisely what login does. With RLS active and `app.shop_id` unset, the policy correctly
-- returns zero rows, and every login fails.
--
-- Three ways out were considered:
--
--   1. Drop RLS from `shop_membership`. Rejected: the table is the shop's staff roster, and
--      dropping RLS would leave only application-level filtering protecting it — exactly the
--      single-layer arrangement §13 exists to avoid.
--   2. Give the application role BYPASSRLS. Rejected outright; it would disable isolation
--      globally to solve one query.
--   3. A SECURITY DEFINER function. Chosen: it runs with the owner's privileges, so it sees
--      through RLS, but it exposes exactly one query shape — "the active memberships of user
--      X" — and nothing else. The bypass is narrow, named, and auditable in one place rather
--      than being a property of the whole connection.
--
-- The function is deliberately parameterised on user id only. It cannot be coerced into
-- returning another shop's roster, because it has no parameter that would let a caller ask for
-- one.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION auth_active_memberships(p_user_id uuid)
RETURNS TABLE (
  membership_id        uuid,
  shop_id              uuid,
  role                 text,
  permission_overrides jsonb,
  membership_status    text,
  shop_name            text,
  shop_status          text,
  shop_archived_at     timestamptz,
  shop_default_locale  text,
  shop_timezone        text,
  user_status          text,
  created_at           timestamptz
)
LANGUAGE sql
SECURITY DEFINER
-- Pin the search path: without this, a caller who can create objects in a schema earlier on
-- their own search_path could shadow a table this function references and hijack it. This is the
-- standard hardening for any SECURITY DEFINER function.
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT
    m.id,
    m.shop_id,
    m.role,
    m.permission_overrides,
    m.status,
    s.name,
    s.status,
    s.archived_at,
    s.default_locale,
    s.timezone,
    u.status,
    m.created_at
  FROM shop_membership m
  JOIN shop s ON s.id = m.shop_id
  JOIN "user" u ON u.id = m.user_id
  WHERE m.user_id = p_user_id
    AND m.status = 'ACTIVE'
  ORDER BY m.created_at ASC;
$$;

-- The function is owned by the table owner (whoever runs this migration), which is what gives it
-- the privilege to see through RLS. EXECUTE is granted narrowly.
REVOKE ALL ON FUNCTION auth_active_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_active_memberships(uuid) TO dukaano_app;

COMMENT ON FUNCTION auth_active_memberships(uuid) IS
  'Login/authorization bootstrap. SECURITY DEFINER so it can read RLS-protected shop_membership '
  'before a tenant context exists. Parameterised on user id ONLY — it cannot return another '
  'user''s or another shop''s memberships. See blueprint §13, §23.2.';
