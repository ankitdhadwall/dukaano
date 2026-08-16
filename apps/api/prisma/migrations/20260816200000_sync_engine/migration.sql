-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 3 — sync engine support (blueprint §14)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 1. When a device last completed a pull
--
-- The cursor is an xid8 watermark and carries no timestamp, so it cannot answer "has this device
-- been away longer than change-log retention?" — the question that decides delta vs bootstrap
-- (§14.5). `last_seen_at` is not a substitute: it moves on any authenticated request, so a device
-- whose user merely opened the app every day for a month would look freshly synced while its
-- cursor rotted.
-- ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE device ADD COLUMN IF NOT EXISTS last_pulled_at TIMESTAMPTZ(3);

-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 2. Change-log pruning support
--
-- The delta query is served by (shop_id, txid, id), which already exists. Pruning walks by age
-- instead and would otherwise seq-scan the largest table in the database every night.
-- ───────────────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS change_log_changed_at_idx ON change_log (changed_at);

-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 3. `processed_operation` — the duplicate-sale defence (§14.4)
--
-- The primary key on op_id is what makes replay a no-op. These add the two access paths the
-- sync module needs beyond it: pruning by age, and answering "what happened to this batch?"
-- ───────────────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS processed_operation_shop_device_idx
  ON processed_operation (shop_id, device_id, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 4. Number leases (§14.6)
--
-- A device asks for a new block when its current one runs low, and two requests racing must not
-- receive overlapping ranges — two customers would hold receipts bearing the same invoice number,
-- which is the one outcome worse than a gap in the sequence.
--
-- The existing UNIQUE (shop_id, series, range_from) makes an overlapping allocation *fail*, which
-- is the correctness backstop. This partial index makes finding a device's live lease cheap, and
-- the allocator takes a transaction-scoped advisory lock per (shop, series) so racing requests
-- serialize instead of colliding and retrying.
-- ───────────────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS number_lease_active_idx
  ON number_lease (shop_id, device_id, series)
  WHERE exhausted_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 5. Conflict inbox (§14.9)
--
-- "Nothing is ever discarded silently." The inbox is read filtered to unacknowledged rows, which
-- is a small fraction of the table on a healthy shop and the whole point of the partial index.
-- ───────────────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS sync_conflict_unacknowledged_idx
  ON sync_conflict (shop_id, created_at DESC)
  WHERE acknowledged_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 6. Sync-table grants
--
-- `change_log`, `processed_operation` and `sync_conflict` already carry RLS and a
-- `tenant_isolation` policy from the initial RLS migration — they are in its tenant-table list.
-- Their policies are deliberately NOT touched here: that policy has both USING and WITH CHECK,
-- and WITH CHECK is what stops the application role inserting a row bearing another shop's
-- shop_id. Re-creating a policy with only USING would leave reads guarded and writes open, which
-- is a tenant leak that reads as working correctly in every test that only checks SELECTs.
--
-- What is missing is the grants the sync module needs.
-- ───────────────────────────────────────────────────────────────────────────────────────────

-- change_log.id is BIGSERIAL; inserting requires its sequence.
GRANT USAGE, SELECT ON SEQUENCE change_log_id_seq TO dukaano_app;

-- Pruning deletes from these two. DELETE stays narrowly granted, per the allowlist principle in
-- the RLS migration — every other tenant table remains INSERT/UPDATE only, so a bug cannot erase
-- a shop's sales or ledger.
GRANT DELETE ON change_log TO dukaano_app;
GRANT DELETE ON processed_operation TO dukaano_app;
