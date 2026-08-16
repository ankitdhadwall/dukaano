-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Platform pruning for the sync tables (blueprint §14.4, §14.5)
--
-- `change_log` and `processed_operation` are tenant tables with the standard RLS policy, so a
-- DELETE issued by the application role with no `app.shop_id` set matches **nothing** and reports
-- success having removed zero rows. Retention would appear to run nightly, forever, while both
-- tables grew without bound — and the first symptom would be a disk alert months later.
--
-- This is the same trap the reconciliation sweep hit with `platform_shop_directory()`, and it gets
-- the same narrow answer rather than BYPASSRLS on the role.
--
-- WHAT THIS FUNCTION CAN AND CANNOT DO
--
-- It deletes **by age only**. There is no shop id anywhere in its body, so there is no parameter
-- that could be manipulated to target one tenant, and no path by which it returns tenant data —
-- it returns two counts. Retention is a platform policy rather than a tenant one, which is why it
-- is expressed platform-wide.
--
-- The cutoffs are passed in rather than hardcoded so the retention windows have exactly one
-- definition, in @dukaano/business-logic, shared with `decideBootstrap`. Pruning and the
-- bootstrap rule MUST agree: if change-log retention were shortened without the bootstrap
-- threshold following, a device would be told a delta was safe and handed an incomplete one.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION platform_prune_sync_tables(
  p_change_log_cutoff  timestamptz,
  p_operation_cutoff   timestamptz
)
RETURNS TABLE (change_log_deleted bigint, operations_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_change_log bigint;
  v_operations bigint;
BEGIN
  DELETE FROM change_log WHERE changed_at < p_change_log_cutoff;
  GET DIAGNOSTICS v_change_log = ROW_COUNT;

  DELETE FROM processed_operation WHERE created_at < p_operation_cutoff;
  GET DIAGNOSTICS v_operations = ROW_COUNT;

  RETURN QUERY SELECT v_change_log, v_operations;
END
$$;

REVOKE ALL ON FUNCTION platform_prune_sync_tables(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_prune_sync_tables(timestamptz, timestamptz) TO dukaano_app;
