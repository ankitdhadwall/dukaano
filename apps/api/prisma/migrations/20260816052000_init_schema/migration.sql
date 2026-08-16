-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_hi" TEXT NOT NULL,
    "price_paise" BIGINT NOT NULL,
    "billing_period" TEXT NOT NULL,
    "trial_days" INTEGER NOT NULL DEFAULT 14,
    "entitlements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "limits" JSONB NOT NULL DEFAULT '{}',
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_category" (
    "id" UUID NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_hi" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "master_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_product" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_hi" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unit_code" TEXT NOT NULL,
    "hint_price_paise" BIGINT,
    "is_common" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "master_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'SUPPORT',
    "can_impersonate_write" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flag" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "targeting" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feature_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "shop_type" TEXT NOT NULL DEFAULT 'KIRANA',
    "phone" VARCHAR(20),
    "email" TEXT,
    "address_line" TEXT,
    "city" TEXT,
    "state_code" TEXT,
    "pincode" VARCHAR(10),
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "default_locale" TEXT NOT NULL DEFAULT 'hi',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "parent_shop_id" UUID,
    "gstin" VARCHAR(15),
    "status" TEXT NOT NULL DEFAULT 'TRIAL',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_settings" (
    "shop_id" UUID NOT NULL,
    "negative_stock_policy" TEXT NOT NULL DEFAULT 'ALLOW',
    "rounding_policy" TEXT NOT NULL DEFAULT 'NONE',
    "business_day_start_hour" INTEGER NOT NULL DEFAULT 0,
    "messaging_channel" TEXT NOT NULL DEFAULT 'WA_DEEPLINK',
    "receipt_footer" TEXT,
    "send_receipt_by_default" BOOLEAN NOT NULL DEFAULT true,
    "reminder_cooldown_days" INTEGER NOT NULL DEFAULT 7,
    "default_low_stock_threshold_milli" BIGINT NOT NULL DEFAULT 0,
    "max_cashier_discount_bp" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("shop_id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "phone_e164" VARCHAR(20),
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "locale" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_membership" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "permission_overrides" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invited_by_user_id" UUID,
    "joined_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "user_id" UUID,
    "name" TEXT,
    "platform" TEXT NOT NULL,
    "app_version" TEXT,
    "os_version" TEXT,
    "push_token" TEXT,
    "last_sync_xmin" TEXT,
    "last_seen_at" TIMESTAMPTZ(3),
    "clock_skew_ms" INTEGER,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_lease" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "series" TEXT NOT NULL DEFAULT 'INV',
    "range_from" INTEGER NOT NULL,
    "range_to" INTEGER NOT NULL,
    "next_value" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exhausted_at" TIMESTAMPTZ(3),

    CONSTRAINT "number_lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TRIALING',
    "trial_ends_at" TIMESTAMPTZ(3),
    "current_period_start" TIMESTAMPTZ(3) NOT NULL,
    "current_period_end" TIMESTAMPTZ(3) NOT NULL,
    "grace_until" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counter" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "usage_counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "master_category_id" UUID,
    "name_en" TEXT,
    "name_hi" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "master_product_id" UUID,
    "category_id" UUID,
    "name_en" TEXT,
    "name_hi" TEXT,
    "sku" TEXT,
    "short_code" TEXT,
    "barcode" TEXT,
    "unit_code" TEXT NOT NULL,
    "selling_price_paise" BIGINT NOT NULL,
    "purchase_price_paise" BIGINT,
    "mrp_paise" BIGINT,
    "low_stock_threshold_milli" BIGINT NOT NULL DEFAULT 0,
    "tax_rate_bp" INTEGER NOT NULL DEFAULT 0,
    "hsn_code" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(3),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "client_updated_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_alias" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,

    CONSTRAINT "product_alias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balance" (
    "shop_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "qty_milli" BIGINT NOT NULL DEFAULT 0,
    "avg_cost_paise" BIGINT NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_balance_pkey" PRIMARY KEY ("shop_id","product_id")
);

-- CreateTable
CREATE TABLE "inventory_transaction" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "qty_delta_milli" BIGINT NOT NULL,
    "balance_after_milli" BIGINT NOT NULL,
    "unit_cost_paise" BIGINT,
    "ref_type" TEXT,
    "ref_id" UUID,
    "reason" TEXT,
    "note" TEXT,
    "actor_user_id" UUID,
    "device_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "op_id" UUID,

    CONSTRAINT "inventory_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone_e164" VARCHAR(20),
    "address" TEXT,
    "notes" TEXT,
    "credit_limit_paise" BIGINT,
    "messaging_opted_out_at" TIMESTAMPTZ(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(3),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "client_updated_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_balance" (
    "shop_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "outstanding_paise" BIGINT NOT NULL DEFAULT 0,
    "last_entry_id" UUID,
    "last_activity_at" TIMESTAMPTZ(3),
    "version" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_balance_pkey" PRIMARY KEY ("shop_id","customer_id")
);

-- CreateTable
CREATE TABLE "customer_ledger_entry" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "entry_type" TEXT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "balance_after_paise" BIGINT NOT NULL,
    "ref_type" TEXT,
    "ref_id" UUID,
    "reason" TEXT,
    "note" TEXT,
    "actor_user_id" UUID,
    "device_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "op_id" UUID,

    CONSTRAINT "customer_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "sale_number" TEXT NOT NULL,
    "customer_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "subtotal_paise" BIGINT NOT NULL,
    "line_discount_paise" BIGINT NOT NULL DEFAULT 0,
    "bill_discount_paise" BIGINT NOT NULL DEFAULT 0,
    "rounding_adjustment_paise" BIGINT NOT NULL DEFAULT 0,
    "total_paise" BIGINT NOT NULL,
    "paid_paise" BIGINT NOT NULL DEFAULT 0,
    "credit_paise" BIGINT NOT NULL DEFAULT 0,
    "business_date" DATE NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MOBILE',
    "drove_stock_negative" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" UUID,
    "cancel_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "device_id" UUID,
    "op_id" UUID,
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_item" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "unit_snapshot" TEXT NOT NULL,
    "qty_milli" BIGINT NOT NULL,
    "unit_price_paise" BIGINT NOT NULL,
    "discount_paise" BIGINT NOT NULL DEFAULT 0,
    "line_total_paise" BIGINT NOT NULL,
    "cost_paise_snapshot" BIGINT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sale_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "customer_id" UUID,
    "sale_id" UUID,
    "direction" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "business_date" DATE NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "reversed_by_payment_id" UUID,
    "reversal_of_payment_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "device_id" UUID,
    "op_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone_e164" VARCHAR(20),
    "address" TEXT,
    "gstin" VARCHAR(15),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(3),
    "row_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_operation" (
    "op_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "device_id" UUID,
    "user_id" UUID,
    "entity" TEXT NOT NULL,
    "entity_id" UUID,
    "op_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_operation_pkey" PRIMARY KEY ("op_id")
);

-- CreateTable
CREATE TABLE "change_log" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "op" TEXT NOT NULL,
    "row_version" BIGINT NOT NULL,
    "txid" xid8 NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_conflict" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "device_id" UUID,
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "client_payload" JSONB NOT NULL,
    "server_payload" JSONB NOT NULL,
    "resolution" TEXT NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "acknowledged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_conflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "shop_id" UUID,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "acting_as_admin_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "user_id" UUID,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "title_key" TEXT NOT NULL,
    "body_key" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "action_url" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_code_key" ON "plan"("code");

-- CreateIndex
CREATE INDEX "master_product_category_id_sort_order_idx" ON "master_product"("category_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_email_key" ON "platform_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_key_key" ON "feature_flag"("key");

-- CreateIndex
CREATE INDEX "shop_status_idx" ON "shop"("status");

-- CreateIndex
CREATE UNIQUE INDEX "user_phone_e164_key" ON "user"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "shop_membership_user_id_status_idx" ON "shop_membership"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shop_membership_shop_id_user_id_key" ON "shop_membership"("shop_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_membership_shop_id_id_key" ON "shop_membership"("shop_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_revoked_at_idx" ON "session"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "session_family_id_idx" ON "session"("family_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "device_shop_id_revoked_at_idx" ON "device"("shop_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_shop_id_id_key" ON "device"("shop_id", "id");

-- CreateIndex
CREATE INDEX "number_lease_shop_id_device_id_exhausted_at_idx" ON "number_lease"("shop_id", "device_id", "exhausted_at");

-- CreateIndex
CREATE UNIQUE INDEX "number_lease_shop_id_series_range_from_key" ON "number_lease"("shop_id", "series", "range_from");

-- CreateIndex
CREATE INDEX "subscription_shop_id_status_idx" ON "subscription"("shop_id", "status");

-- CreateIndex
CREATE INDEX "subscription_status_current_period_end_idx" ON "subscription"("status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counter_shop_id_period_metric_key" ON "usage_counter"("shop_id", "period", "metric");

-- CreateIndex
CREATE INDEX "category_shop_id_archived_at_idx" ON "category"("shop_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "category_shop_id_id_key" ON "category"("shop_id", "id");

-- CreateIndex
CREATE INDEX "product_shop_id_is_active_idx" ON "product"("shop_id", "is_active");

-- CreateIndex
CREATE INDEX "product_shop_id_category_id_idx" ON "product"("shop_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_shop_id_id_key" ON "product"("shop_id", "id");

-- CreateIndex
CREATE INDEX "product_alias_shop_id_idx" ON "product_alias"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_alias_shop_id_product_id_alias_key" ON "product_alias"("shop_id", "product_id", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transaction_op_id_key" ON "inventory_transaction"("op_id");

-- CreateIndex
CREATE INDEX "inventory_transaction_shop_id_product_id_occurred_at_id_idx" ON "inventory_transaction"("shop_id", "product_id", "occurred_at" DESC, "id");

-- CreateIndex
CREATE INDEX "inventory_transaction_shop_id_occurred_at_idx" ON "inventory_transaction"("shop_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "inventory_transaction_shop_id_ref_type_ref_id_idx" ON "inventory_transaction"("shop_id", "ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "customer_shop_id_archived_at_idx" ON "customer"("shop_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_shop_id_id_key" ON "customer"("shop_id", "id");

-- CreateIndex
CREATE INDEX "customer_balance_shop_id_outstanding_paise_idx" ON "customer_balance"("shop_id", "outstanding_paise" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "customer_ledger_entry_op_id_key" ON "customer_ledger_entry"("op_id");

-- CreateIndex
CREATE INDEX "customer_ledger_entry_shop_id_customer_id_occurred_at_id_idx" ON "customer_ledger_entry"("shop_id", "customer_id", "occurred_at" DESC, "id");

-- CreateIndex
CREATE INDEX "customer_ledger_entry_shop_id_ref_type_ref_id_idx" ON "customer_ledger_entry"("shop_id", "ref_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_op_id_key" ON "sale"("op_id");

-- CreateIndex
CREATE INDEX "sale_shop_id_business_date_idx" ON "sale"("shop_id", "business_date" DESC);

-- CreateIndex
CREATE INDEX "sale_shop_id_customer_id_occurred_at_idx" ON "sale"("shop_id", "customer_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "sale_shop_id_created_by_user_id_business_date_idx" ON "sale"("shop_id", "created_by_user_id", "business_date");

-- CreateIndex
CREATE INDEX "sale_shop_id_status_idx" ON "sale"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sale_shop_id_id_key" ON "sale"("shop_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_shop_id_sale_number_key" ON "sale"("shop_id", "sale_number");

-- CreateIndex
CREATE INDEX "sale_item_shop_id_sale_id_idx" ON "sale_item"("shop_id", "sale_id");

-- CreateIndex
CREATE INDEX "sale_item_shop_id_product_id_sale_id_idx" ON "sale_item"("shop_id", "product_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_reversed_by_payment_id_key" ON "payment"("reversed_by_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_op_id_key" ON "payment"("op_id");

-- CreateIndex
CREATE INDEX "payment_shop_id_business_date_method_idx" ON "payment"("shop_id", "business_date" DESC, "method");

-- CreateIndex
CREATE INDEX "payment_shop_id_customer_id_occurred_at_idx" ON "payment"("shop_id", "customer_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "payment_shop_id_sale_id_idx" ON "payment"("shop_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_shop_id_id_key" ON "payment"("shop_id", "id");

-- CreateIndex
CREATE INDEX "payment_allocation_shop_id_sale_id_idx" ON "payment_allocation"("shop_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocation_shop_id_payment_id_sale_id_key" ON "payment_allocation"("shop_id", "payment_id", "sale_id");

-- CreateIndex
CREATE INDEX "supplier_shop_id_archived_at_idx" ON "supplier"("shop_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_shop_id_id_key" ON "supplier"("shop_id", "id");

-- CreateIndex
CREATE INDEX "processed_operation_shop_id_created_at_idx" ON "processed_operation"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "processed_operation_created_at_idx" ON "processed_operation"("created_at");

-- CreateIndex
CREATE INDEX "change_log_shop_id_txid_id_idx" ON "change_log"("shop_id", "txid", "id");

-- CreateIndex
CREATE INDEX "sync_conflict_shop_id_acknowledged_at_idx" ON "sync_conflict"("shop_id", "acknowledged_at");

-- CreateIndex
CREATE INDEX "audit_log_shop_id_created_at_idx" ON "audit_log"("shop_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_shop_id_entity_type_entity_id_idx" ON "audit_log"("shop_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_user_id_created_at_idx" ON "audit_log"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_shop_id_user_id_read_at_idx" ON "notification"("shop_id", "user_id", "read_at");

-- CreateIndex
CREATE INDEX "notification_shop_id_created_at_idx" ON "notification"("shop_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "master_product" ADD CONSTRAINT "master_product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "master_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_settings" ADD CONSTRAINT "shop_settings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_membership" ADD CONSTRAINT "shop_membership_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_membership" ADD CONSTRAINT "shop_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_lease" ADD CONSTRAINT "number_lease_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_lease" ADD CONSTRAINT "number_lease_shop_id_device_id_fkey" FOREIGN KEY ("shop_id", "device_id") REFERENCES "device"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_shop_id_category_id_fkey" FOREIGN KEY ("shop_id", "category_id") REFERENCES "category"("shop_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_master_product_id_fkey" FOREIGN KEY ("master_product_id") REFERENCES "master_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_alias" ADD CONSTRAINT "product_alias_shop_id_product_id_fkey" FOREIGN KEY ("shop_id", "product_id") REFERENCES "product"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_shop_id_product_id_fkey" FOREIGN KEY ("shop_id", "product_id") REFERENCES "product"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_shop_id_product_id_fkey" FOREIGN KEY ("shop_id", "product_id") REFERENCES "product"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_balance" ADD CONSTRAINT "customer_balance_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_balance" ADD CONSTRAINT "customer_balance_shop_id_customer_id_fkey" FOREIGN KEY ("shop_id", "customer_id") REFERENCES "customer"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_ledger_entry" ADD CONSTRAINT "customer_ledger_entry_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_ledger_entry" ADD CONSTRAINT "customer_ledger_entry_shop_id_customer_id_fkey" FOREIGN KEY ("shop_id", "customer_id") REFERENCES "customer"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_shop_id_customer_id_fkey" FOREIGN KEY ("shop_id", "customer_id") REFERENCES "customer"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_shop_id_sale_id_fkey" FOREIGN KEY ("shop_id", "sale_id") REFERENCES "sale"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_shop_id_product_id_fkey" FOREIGN KEY ("shop_id", "product_id") REFERENCES "product"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_shop_id_customer_id_fkey" FOREIGN KEY ("shop_id", "customer_id") REFERENCES "customer"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_shop_id_sale_id_fkey" FOREIGN KEY ("shop_id", "sale_id") REFERENCES "sale"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_shop_id_payment_id_fkey" FOREIGN KEY ("shop_id", "payment_id") REFERENCES "payment"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_shop_id_sale_id_fkey" FOREIGN KEY ("shop_id", "sale_id") REFERENCES "sale"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
