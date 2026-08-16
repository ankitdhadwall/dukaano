-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Objects Prisma cannot see (run by CI after `prisma migrate deploy`)
--
-- Prisma's datamodel cannot express RLS policies, generated columns, partial or trigram indexes,
-- SECURITY DEFINER functions, or a column default calling pg_current_xact_id(). All of those are
-- created by hand-written migrations — which means nothing in the Prisma toolchain would notice
-- if a migration edit silently dropped one.
--
-- The stakes are not uniform but none of them are small:
--   • losing an RLS policy is a cross-tenant leak
--   • losing product.search_text breaks billing search
--   • losing the change_log.txid default breaks the sync cursor, silently losing changes
--   • losing a SECURITY DEFINER function breaks login, the reconciliation sweep, or retention
--
-- This replaces a `prisma migrate diff --exit-code` step that could never pass, because it
-- asserted the datamodel fully describes the database — false by design here. A check that can
-- only fail teaches people to ignore CI.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  missing text := '';
BEGIN
  -- Generated columns behind search.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'product' AND column_name = 'search_text')
    THEN missing := missing || 'product.search_text '; END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'customer' AND column_name = 'phone_last4')
    THEN missing := missing || 'customer.phone_last4 '; END IF;

  -- The sync cursor is meaningless without this default (blueprint §14.5): the txid must be the
  -- transaction's real id, which only the database can supply correctly.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'change_log' AND column_name = 'txid'
                   AND column_default LIKE '%pg_current_xact_id%')
    THEN missing := missing || 'change_log.txid default '; END IF;

  -- The three narrow RLS bypasses. Each is argued for in an ADR or its own migration.
  IF to_regprocedure('auth_active_memberships(uuid)') IS NULL
    THEN missing := missing || 'auth_active_memberships() '; END IF;
  IF to_regprocedure('platform_shop_directory()') IS NULL
    THEN missing := missing || 'platform_shop_directory() '; END IF;
  IF to_regprocedure('platform_prune_sync_tables(timestamptz,timestamptz)') IS NULL
    THEN missing := missing || 'platform_prune_sync_tables() '; END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'Migrations no longer create: %', missing;
  END IF;
END $$;

-- Every RLS-enabled table must guard writes as well as reads.
--
-- `USING` filters what a query can see; `WITH CHECK` filters what it can write. A policy with only
-- USING lets the application role INSERT a row bearing another shop's shop_id — reads look
-- correctly isolated while writes are wide open. A migration dropped WITH CHECK from three tables
-- during Phase 3 and every existing test still passed, because the tests attack through the API
-- with GETs and PATCHes and this hole is only reachable by a write naming a foreign shop id.
DO $$
DECLARE
  unguarded text;
BEGIN
  SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '')
    INTO unguarded
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'tenant_isolation'
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relrowsecurity
    AND (p.policyname IS NULL OR p.with_check IS NULL);

  IF unguarded <> '' THEN
    RAISE EXCEPTION 'RLS-enabled tables without a WITH CHECK clause: %', unguarded;
  END IF;
END $$;
