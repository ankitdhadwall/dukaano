-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Returns (blueprint §25 E-11, E-12, E-39)
--
-- Hand-written rather than generated. `prisma migrate diff` against this schema also proposes
-- dropping `product.search_text`, `customer.phone_last4`, the trigram indexes and the
-- `change_log.txid` DEFAULT — generated columns and expressions Prisma cannot model and therefore
-- believes are drift. Applying its output would silently destroy product search and break the sync
-- cursor. Only the new objects are taken.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "sale_return" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "customer_id" UUID,
    "return_number" TEXT NOT NULL,
    "total_paise" BIGINT NOT NULL,
    "refund_cash_paise" BIGINT NOT NULL DEFAULT 0,
    "refund_credit_paise" BIGINT NOT NULL DEFAULT 0,
    "reason" TEXT,
    "business_date" DATE NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "device_id" UUID,
    "op_id" UUID,
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sale_return_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "sale_return_item" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "sale_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "qty_milli" BIGINT NOT NULL,
    "unit_price_paise" BIGINT NOT NULL,
    "line_total_paise" BIGINT NOT NULL,
    CONSTRAINT "sale_return_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sale_return_op_id_key" ON "sale_return"("op_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sale_return_shop_id_id_key" ON "sale_return"("shop_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "sale_return_shop_id_return_number_key" ON "sale_return"("shop_id", "return_number");
CREATE INDEX IF NOT EXISTS "sale_return_shop_id_sale_id_idx" ON "sale_return"("shop_id", "sale_id");
CREATE INDEX IF NOT EXISTS "sale_return_shop_id_business_date_idx" ON "sale_return"("shop_id", "business_date" DESC);
CREATE INDEX IF NOT EXISTS "sale_return_item_shop_id_return_id_idx" ON "sale_return_item"("shop_id", "return_id");
CREATE INDEX IF NOT EXISTS "sale_return_item_shop_id_sale_item_id_idx" ON "sale_return_item"("shop_id", "sale_item_id");

-- Composite foreign keys on (shop_id, id), per §13 layer 3: cross-tenant FK stitching is made
-- structurally impossible rather than merely unlikely.
ALTER TABLE "sale_return"
  DROP CONSTRAINT IF EXISTS "sale_return_shop_id_fkey",
  ADD CONSTRAINT "sale_return_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE;
ALTER TABLE "sale_return"
  DROP CONSTRAINT IF EXISTS "sale_return_shop_id_sale_id_fkey",
  ADD CONSTRAINT "sale_return_shop_id_sale_id_fkey" FOREIGN KEY ("shop_id", "sale_id") REFERENCES "sale"("shop_id", "id");
ALTER TABLE "sale_return"
  DROP CONSTRAINT IF EXISTS "sale_return_shop_id_customer_id_fkey",
  ADD CONSTRAINT "sale_return_shop_id_customer_id_fkey" FOREIGN KEY ("shop_id", "customer_id") REFERENCES "customer"("shop_id", "id");
ALTER TABLE "sale_return_item"
  DROP CONSTRAINT IF EXISTS "sale_return_item_shop_id_return_id_fkey",
  ADD CONSTRAINT "sale_return_item_shop_id_return_id_fkey" FOREIGN KEY ("shop_id", "return_id") REFERENCES "sale_return"("shop_id", "id") ON DELETE CASCADE;

-- ───────────────────────────────────────────────────────────────────────────────────────────
-- Integrity that the application must not be the only thing enforcing
-- ───────────────────────────────────────────────────────────────────────────────────────────

-- Refund identity: what came back must equal how it was given back. A return whose parts do not
-- sum to its total is the returns equivalent of a bill that does not reconcile.
ALTER TABLE "sale_return" DROP CONSTRAINT IF EXISTS "sale_return_refund_identity";
ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_refund_identity"
  CHECK (total_paise = refund_cash_paise + refund_credit_paise);

-- Goods coming back are a positive quantity and a positive value. A negative return is a sale,
-- and it must go through the sale path where it gets a bill number and an inventory movement.
ALTER TABLE "sale_return" DROP CONSTRAINT IF EXISTS "sale_return_positive";
ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_positive"
  CHECK (total_paise >= 0 AND refund_cash_paise >= 0 AND refund_credit_paise >= 0);

ALTER TABLE "sale_return_item" DROP CONSTRAINT IF EXISTS "sale_return_item_positive";
ALTER TABLE "sale_return_item" ADD CONSTRAINT "sale_return_item_positive"
  CHECK (qty_milli > 0 AND line_total_paise >= 0);

-- Credit may only be reversed against a customer. Reversing credit on a walk-in cash sale would
-- write a ledger entry with nobody to attribute it to.
ALTER TABLE "sale_return" DROP CONSTRAINT IF EXISTS "sale_return_credit_needs_customer";
ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_credit_needs_customer"
  CHECK (refund_credit_paise = 0 OR customer_id IS NOT NULL);

-- ───────────────────────────────────────────────────────────────────────────────────────────
-- Tenant isolation — the same policy shape as every other tenant table.
--
-- BOTH clauses. `USING` guards reads; `WITH CHECK` guards writes, and without it the application
-- role could insert a return bearing another shop's shop_id. A gate in sync-coverage.spec.ts
-- asserts every RLS-enabled table has both, because this was got wrong once already.
-- ───────────────────────────────────────────────────────────────────────────────────────────
DO $returns_rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sale_return', 'sale_return_item'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (shop_id = NULLIF(current_setting(''app.shop_id'', true), '''')::uuid) '
      'WITH CHECK (shop_id = NULLIF(current_setting(''app.shop_id'', true), '''')::uuid)',
      t
    );
    -- No DELETE grant: a return is a financial document and is append-only like the rest of them.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO dukaano_app', t);
  END LOOP;
END
$returns_rls$;
