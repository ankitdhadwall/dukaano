-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Row-Level Security, integrity constraints, and search indexes
--
-- Blueprint §13 (multi-tenancy), §15.3 (constraints and indexes), §23.3 (isolation).
--
-- Prisma cannot express any of this, so it lives in a hand-written migration. Everything here
-- is idempotent, so re-running it against a partially-migrated database is safe.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 1. Extensions
-- ───────────────────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- prefix/fuzzy product & customer search (§35)
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 2. The application database role
--
-- The API connects as `dukaano_app`, which is NOT the table owner and does NOT have BYPASSRLS.
-- That separation is what makes RLS a real boundary rather than a suggestion: a SQL injection
-- in a WHERE clause, or an application bug that forgets a shop_id filter, still cannot read
-- another shop's rows.
--
-- Note we deliberately do NOT use FORCE ROW LEVEL SECURITY. FORCE exists to apply RLS to the
-- table *owner*; since the application never connects as the owner, plain ENABLE already covers
-- it, while FORCE would additionally break owner-run migrations and seeds for no security gain.
-- The misconfiguration FORCE would have guarded against (pointing the API at the owner
-- connection string) is instead caught at boot by an explicit assertion in PrismaService, which
-- refuses to start if the connected role is the owner or holds BYPASSRLS. That check is
-- stronger than FORCE because it fails loudly instead of silently filtering.
--
-- In production this role is provisioned by infrastructure-as-code and this block is a no-op.
-- ───────────────────────────────────────────────────────────────────────────────────────────

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dukaano_app') THEN
    CREATE ROLE dukaano_app LOGIN PASSWORD 'dukaano_dev_only' NOBYPASSRLS;
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO dukaano_app;

-- SELECT/INSERT/UPDATE everywhere. DELETE is granted nowhere by default: financial documents
-- have no delete path at all (§15.3), and the few tables that legitimately need row removal are
-- allowlisted explicitly below.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO dukaano_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dukaano_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO dukaano_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dukaano_app;

-- The DELETE allowlist. Every table absent from this list is append-only or archive-only as far
-- as the application is concerned.
GRANT DELETE ON TABLE "session"        TO dukaano_app;  -- logout / revocation
GRANT DELETE ON TABLE "product_alias"  TO dukaano_app;  -- editing a product's search keywords
GRANT DELETE ON TABLE "notification"   TO dukaano_app;  -- dismissing a notification
GRANT DELETE ON TABLE "sync_conflict"  TO dukaano_app;  -- resolving the conflict inbox


-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 3. Row-Level Security
--
-- Applied uniformly by iterating a table list, so a new tenant table cannot be given a subtly
-- different policy by hand. `current_setting('app.shop_id', true)` returns NULL when unset,
-- and `shop_id = NULL` matches nothing — the policy fails CLOSED. A request that somehow
-- reaches the database without a tenant context sees an empty database, not another shop's.
-- ───────────────────────────────────────────────────────────────────────────────────────────

DO $rls$
DECLARE
  tenant_table text;
  tenant_tables text[] := ARRAY[
    'shop_settings', 'shop_membership', 'device', 'number_lease',
    'subscription', 'usage_counter',
    'category', 'product', 'product_alias',
    'inventory_balance', 'inventory_transaction',
    'customer', 'customer_balance', 'customer_ledger_entry',
    'sale', 'sale_item',
    'payment', 'payment_allocation',
    'supplier',
    'processed_operation', 'change_log', 'sync_conflict',
    'audit_log', 'notification'
  ];
BEGIN
  FOREACH tenant_table IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (shop_id = NULLIF(current_setting(''app.shop_id'', true), '''')::uuid) '
      'WITH CHECK (shop_id = NULLIF(current_setting(''app.shop_id'', true), '''')::uuid)',
      tenant_table
    );
  END LOOP;
END
$rls$;

-- `shop` itself is keyed on `id` rather than `shop_id`.
ALTER TABLE "shop" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "shop";
CREATE POLICY tenant_isolation ON "shop"
  USING      (id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

-- `audit_log` may carry a NULL shop_id for platform-level events. Those rows belong to no
-- tenant and must never be visible to a shop, which the policy above already achieves
-- (NULL = <uuid> is NULL, not true) — recorded here so the asymmetry is not "fixed" later.

-- Deliberately WITHOUT RLS, and why:
--   user, session          — cross-tenant by nature; a user may belong to several shops (E-36),
--                            and login must read them before any shop context exists. Only the
--                            auth module touches these tables.
--   plan, feature_flag,
--   master_category,
--   master_product         — platform catalogue, read-only to shop-facing code.
--   platform_user          — the super-admin realm, which never shares a connection pool with
--                            shop traffic (§8).


-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 4. Integrity constraints
--
-- These encode business invariants that must hold no matter which code path writes the row —
-- including a future sync writer, a data migration, or a hand-run SQL fix at 2 a.m.
-- ───────────────────────────────────────────────────────────────────────────────────────────

-- §22.4: a product must be nameable in at least one language. We never auto-translate the other.
ALTER TABLE "product" DROP CONSTRAINT IF EXISTS product_has_a_name;
ALTER TABLE "product" ADD CONSTRAINT product_has_a_name
  CHECK (name_en IS NOT NULL OR name_hi IS NOT NULL);

ALTER TABLE "product" DROP CONSTRAINT IF EXISTS product_prices_non_negative;
ALTER TABLE "product" ADD CONSTRAINT product_prices_non_negative
  CHECK (selling_price_paise >= 0
     AND (purchase_price_paise IS NULL OR purchase_price_paise >= 0)
     AND (mrp_paise IS NULL OR mrp_paise >= 0));

-- §19.1 (binding): udhaar requires a customer. Without a customer there is no ledger to debit,
-- so an unattributed credit sale is money the shop can never collect.
ALTER TABLE "sale" DROP CONSTRAINT IF EXISTS sale_credit_requires_customer;
ALTER TABLE "sale" ADD CONSTRAINT sale_credit_requires_customer
  CHECK (credit_paise = 0 OR customer_id IS NOT NULL);

-- §15.1 (binding): the bill identity, enforced by the database itself.
--   subtotal - billDiscount + roundingAdjustment = total
-- @dukaano/money guarantees this by construction and a property test covers it, but encoding it
-- here means no code path anywhere — including one written years from now — can persist a bill
-- that does not add up.
ALTER TABLE "sale" DROP CONSTRAINT IF EXISTS sale_totals_reconcile;
ALTER TABLE "sale" ADD CONSTRAINT sale_totals_reconcile
  CHECK (subtotal_paise - bill_discount_paise + rounding_adjustment_paise = total_paise);

-- §19.1: total = paid + credit. The other half of the same invariant.
ALTER TABLE "sale" DROP CONSTRAINT IF EXISTS sale_payment_split_reconciles;
ALTER TABLE "sale" ADD CONSTRAINT sale_payment_split_reconciles
  CHECK (paid_paise + credit_paise = total_paise);

-- Amount is always positive; `direction` carries the sign semantics (§19.3).
ALTER TABLE "payment" DROP CONSTRAINT IF EXISTS payment_amount_positive;
ALTER TABLE "payment" ADD CONSTRAINT payment_amount_positive
  CHECK (amount_paise > 0);

ALTER TABLE "payment" DROP CONSTRAINT IF EXISTS payment_direction_valid;
ALTER TABLE "payment" ADD CONSTRAINT payment_direction_valid
  CHECK (direction IN ('IN', 'OUT'));

-- A zero-delta stock movement is always a bug: it records nothing and pollutes the history.
ALTER TABLE "inventory_transaction" DROP CONSTRAINT IF EXISTS inventory_delta_non_zero;
ALTER TABLE "inventory_transaction" ADD CONSTRAINT inventory_delta_non_zero
  CHECK (qty_delta_milli <> 0);

-- §17.1: DAMAGE, WASTAGE, ADJUSTMENT and CORRECTION require a reason. Stock never changes
-- without a trace, and "who reduced my sugar by 2 kg and why" must always be answerable.
ALTER TABLE "inventory_transaction" DROP CONSTRAINT IF EXISTS inventory_reason_required;
ALTER TABLE "inventory_transaction" ADD CONSTRAINT inventory_reason_required
  CHECK (
    type NOT IN ('DAMAGE', 'WASTAGE', 'ADJUSTMENT', 'CORRECTION')
    OR (reason IS NOT NULL AND length(trim(reason)) > 0)
  );

-- §18.2: adjustments and write-offs to a customer's khata always carry a reason.
ALTER TABLE "customer_ledger_entry" DROP CONSTRAINT IF EXISTS ledger_reason_required;
ALTER TABLE "customer_ledger_entry" ADD CONSTRAINT ledger_reason_required
  CHECK (
    entry_type NOT IN ('ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT', 'WRITE_OFF', 'PAYMENT_REVERSED')
    OR (reason IS NOT NULL AND length(trim(reason)) > 0)
  );

-- A ledger entry that moves nothing is a bug.
ALTER TABLE "customer_ledger_entry" DROP CONSTRAINT IF EXISTS ledger_amount_non_zero;
ALTER TABLE "customer_ledger_entry" ADD CONSTRAINT ledger_amount_non_zero
  CHECK (amount_paise <> 0);

ALTER TABLE "sale_item" DROP CONSTRAINT IF EXISTS sale_item_qty_non_zero;
ALTER TABLE "sale_item" ADD CONSTRAINT sale_item_qty_non_zero
  CHECK (qty_milli <> 0);

-- §25 E-20.
ALTER TABLE "shop_settings" DROP CONSTRAINT IF EXISTS shop_business_day_hour_valid;
ALTER TABLE "shop_settings" ADD CONSTRAINT shop_business_day_hour_valid
  CHECK (business_day_start_hour BETWEEN 0 AND 23);

ALTER TABLE "shop_settings" DROP CONSTRAINT IF EXISTS shop_negative_stock_policy_valid;
ALTER TABLE "shop_settings" ADD CONSTRAINT shop_negative_stock_policy_valid
  CHECK (negative_stock_policy IN ('ALLOW', 'WARN', 'BLOCK'));

ALTER TABLE "shop_settings" DROP CONSTRAINT IF EXISTS shop_rounding_policy_valid;
ALTER TABLE "shop_settings" ADD CONSTRAINT shop_rounding_policy_valid
  CHECK (rounding_policy IN ('NONE', 'NEAREST_RUPEE', 'NEAREST_5_RUPEES'));

ALTER TABLE "shop_membership" DROP CONSTRAINT IF EXISTS membership_role_valid;
ALTER TABLE "shop_membership" ADD CONSTRAINT membership_role_valid
  CHECK (role IN ('OWNER', 'MANAGER', 'CASHIER'));

-- A number lease must describe a real, forward range the device can draw from (§14.6).
ALTER TABLE "number_lease" DROP CONSTRAINT IF EXISTS number_lease_range_valid;
ALTER TABLE "number_lease" ADD CONSTRAINT number_lease_range_valid
  CHECK (range_to >= range_from AND next_value >= range_from AND next_value <= range_to + 1);


-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 5. Partial unique indexes
--
-- Uniqueness is scoped to the shop AND excludes archived rows, so a shop may reuse a code after
-- archiving a product, and two different shops may both use "SUG01" (§25 E-14, E-15, E-16).
-- ───────────────────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS product_sku_uq
  ON "product" (shop_id, lower(sku))
  WHERE sku IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_short_code_uq
  ON "product" (shop_id, lower(short_code))
  WHERE short_code IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_barcode_uq
  ON "product" (shop_id, barcode)
  WHERE barcode IS NOT NULL AND archived_at IS NULL;

-- One phone number = one customer, per shop (§25 E-16).
CREATE UNIQUE INDEX IF NOT EXISTS customer_phone_uq
  ON "customer" (shop_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS supplier_phone_uq
  ON "supplier" (shop_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND archived_at IS NULL;


-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 6. Search (§5, §35)
--
-- Billing search must feel instant: typing "sug" shows Sugar Loose, Sugar 1kg, Sugar 500g
-- before the shopkeeper's finger leaves the key. A generated column keeps the searchable text
-- in one place, and a GIN trigram index makes both prefix and fuzzy matching fast.
-- ───────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "product" DROP COLUMN IF EXISTS search_text;
ALTER TABLE "product" ADD COLUMN search_text text
  GENERATED ALWAYS AS (
    lower(
      coalesce(name_en, '') || ' ' ||
      coalesce(name_hi, '') || ' ' ||
      coalesce(sku, '')     || ' ' ||
      coalesce(short_code, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS product_search_trgm
  ON "product" USING GIN (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS product_alias_trgm
  ON "product_alias" USING GIN (lower(alias) gin_trgm_ops);

-- §35: typing "8254" finds Ramesh Sharma 98XXXX8254 — how a shopkeeper actually remembers
-- a customer's number.
ALTER TABLE "customer" DROP COLUMN IF EXISTS phone_last4;
ALTER TABLE "customer" ADD COLUMN phone_last4 text
  GENERATED ALWAYS AS (right(phone_e164, 4)) STORED;

CREATE INDEX IF NOT EXISTS customer_phone_last4
  ON "customer" (shop_id, phone_last4)
  WHERE phone_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_name_trgm
  ON "customer" USING GIN (lower(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS supplier_name_trgm
  ON "supplier" USING GIN (lower(name) gin_trgm_ops);


-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 7. The sync change log (§14.5)
--
-- `txid` is what makes delta pull correct. BIGSERIAL ids are allocated at INSERT but become
-- visible at COMMIT, so a transaction holding id 100 can commit AFTER one holding id 105. A
-- cursor keyed on `id` alone would serve 105, advance past it, and permanently lose row 100 —
-- a silently missing sale on a shopkeeper's device, essentially impossible to reproduce in
-- testing and catastrophic in production.
--
-- Instead the cursor is an xmin watermark: pull serves only rows whose inserting transaction is
-- below pg_snapshot_xmin(pg_current_snapshot()), i.e. rows that no in-flight transaction can
-- still precede. Rows at exactly the watermark may be re-served; the client's apply step is an
-- idempotent upsert keyed on (entity, id, row_version), so overlap costs nothing.
--
-- xid8 is 64-bit and therefore wraparound-safe, unlike the legacy 32-bit xid.
-- ───────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "change_log" ALTER COLUMN txid SET DEFAULT pg_current_xact_id();

CREATE INDEX IF NOT EXISTS change_log_watermark
  ON "change_log" (shop_id, txid, id);


-- ───────────────────────────────────────────────────────────────────────────────────────────
-- 8. Reporting indexes not expressible in the Prisma schema
-- ───────────────────────────────────────────────────────────────────────────────────────────

-- The khata list and the ageing report both read "who owes money", never "who owes nothing".
-- A partial index keeps it small in a shop where most customers are settled.
CREATE INDEX IF NOT EXISTS customer_balance_outstanding
  ON "customer_balance" (shop_id, outstanding_paise DESC)
  WHERE outstanding_paise > 0;

-- Low-stock dashboard tile and the Low Stock page.
CREATE INDEX IF NOT EXISTS inventory_balance_low_stock
  ON "inventory_balance" (shop_id, qty_milli);

-- Idempotency lookups on the sync push path are the hottest read in the system.
CREATE INDEX IF NOT EXISTS processed_operation_shop_device
  ON "processed_operation" (shop_id, device_id, created_at DESC);
