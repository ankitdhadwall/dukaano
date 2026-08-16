/**
 * The shared domain vocabulary.
 *
 * These are the *canonical* definitions. Prisma enums mirror them (asserted by a test in
 * apps/api that diffs the two, so a schema change that forgets this file fails CI), and both
 * clients import from here. Values are SCREAMING_SNAKE strings rather than numbers so that a
 * database row, a JSON sync payload and a log line all read the same.
 */

// --- Identity & tenancy --------------------------------------------------------------------

export const SHOP_ROLES = ['OWNER', 'MANAGER', 'CASHIER'] as const
export type ShopRole = (typeof SHOP_ROLES)[number]

export const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED'] as const
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number]

export const SHOP_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CLOSED'] as const
export type ShopStatus = (typeof SHOP_STATUSES)[number]

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETED'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

export const DEVICE_PLATFORMS = ['ANDROID', 'IOS', 'WEB'] as const
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number]

/** Blueprint §22.3. A TEXT column, not a DB enum, so Punjabi is additive (§22.6). */
export const LOCALES = ['en', 'hi'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'hi'

// --- Catalogue -----------------------------------------------------------------------------

/**
 * Units a Kirana shop actually transacts in.
 *
 * `decimals` is the precision the UI permits for this unit and is enforced at parse time, so
 * "1.5 pieces" is rejected at the source rather than silently truncated (§25 E-22). Storage is
 * always milli-units regardless — the unit only constrains input.
 *
 * Blueprint A-7: there is deliberately NO unit conversion in MVP. "Sugar loose (kg)" and
 * "Sugar 1kg packet" are separate products, which is how the shop thinks about them anyway.
 * Conversion tables are a classic complexity trap that buys nothing here.
 */
export const UNIT_DEFINITIONS = {
  PIECE: { decimals: 0, nameEn: 'Piece', nameHi: 'नग' },
  PACKET: { decimals: 0, nameEn: 'Packet', nameHi: 'पैकेट' },
  BOX: { decimals: 0, nameEn: 'Box', nameHi: 'डिब्बा' },
  DOZEN: { decimals: 0, nameEn: 'Dozen', nameHi: 'दर्जन' },
  BOTTLE: { decimals: 0, nameEn: 'Bottle', nameHi: 'बोतल' },
  BAG: { decimals: 0, nameEn: 'Bag', nameHi: 'बोरी' },
  KG: { decimals: 3, nameEn: 'Kilogram', nameHi: 'किलो' },
  GRAM: { decimals: 0, nameEn: 'Gram', nameHi: 'ग्राम' },
  LITRE: { decimals: 3, nameEn: 'Litre', nameHi: 'लीटर' },
  ML: { decimals: 0, nameEn: 'Millilitre', nameHi: 'मिलीलीटर' },
  METRE: { decimals: 2, nameEn: 'Metre', nameHi: 'मीटर' },
} as const

export const UNIT_CODES = Object.keys(UNIT_DEFINITIONS) as readonly UnitCode[]
export type UnitCode = keyof typeof UNIT_DEFINITIONS

// --- Inventory -----------------------------------------------------------------------------

/**
 * Blueprint §17.1. Every stock movement is one of these, and every one of them is an
 * append-only row — inventory is never silently changed (§13 of the brief, §17.2 here).
 *
 * `sign` documents the only direction each type may move stock, and is asserted at write time.
 * ADJUSTMENT and CORRECTION are the two that may go either way, which is exactly why both
 * require a reason.
 */
export const INVENTORY_TRANSACTION_TYPES = {
  OPENING_STOCK: { sign: 'IN', requiresReason: false },
  PURCHASE: { sign: 'IN', requiresReason: false },
  SALE: { sign: 'OUT', requiresReason: false },
  SALE_CANCEL: { sign: 'IN', requiresReason: false },
  CUSTOMER_RETURN: { sign: 'IN', requiresReason: false },
  SUPPLIER_RETURN: { sign: 'OUT', requiresReason: false },
  DAMAGE: { sign: 'OUT', requiresReason: true },
  WASTAGE: { sign: 'OUT', requiresReason: true },
  ADJUSTMENT: { sign: 'ANY', requiresReason: true },
  CORRECTION: { sign: 'ANY', requiresReason: true },
} as const

export type InventoryTransactionType = keyof typeof INVENTORY_TRANSACTION_TYPES
export const INVENTORY_TRANSACTION_TYPE_LIST = Object.keys(
  INVENTORY_TRANSACTION_TYPES,
) as readonly InventoryTransactionType[]

/** Blueprint §17.3. `BLOCK` is documented as unenforceable offline — see the settings copy. */
export const NEGATIVE_STOCK_POLICIES = ['ALLOW', 'WARN', 'BLOCK'] as const
export type NegativeStockPolicy = (typeof NEGATIVE_STOCK_POLICIES)[number]

// --- Sales ---------------------------------------------------------------------------------

/** A sale is never deleted. CANCELLED keeps the row and adds compensating entries (§25 E-12). */
export const SALE_STATUSES = ['COMPLETED', 'CANCELLED'] as const
export type SaleStatus = (typeof SALE_STATUSES)[number]

export const SALE_SOURCES = ['MOBILE', 'WEB'] as const
export type SaleSource = (typeof SALE_SOURCES)[number]

// --- Payments ------------------------------------------------------------------------------

/**
 * Blueprint §19.1 (binding): a payment row is real money moving. "Udhaar" is a payment
 * *selection* in the UI but produces a ledger entry, never a payment row — which is why it does
 * not appear in this list. Putting it here is the single most likely way to reintroduce the
 * double-counting bug this design exists to prevent.
 */
export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

/** IN = money from the customer. OUT = refund to the customer. */
export const PAYMENT_DIRECTIONS = ['IN', 'OUT'] as const
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number]

// --- Customer ledger -------------------------------------------------------------------------

/**
 * Blueprint §18.2. `sign` is the direction the entry moves the customer's outstanding balance:
 * DEBIT increases what they owe, CREDIT decreases it. The ledger is append-only, so a mistake is
 * corrected by appending a reversing entry, never by editing one of these.
 */
export const LEDGER_ENTRY_TYPES = {
  OPENING_BALANCE: { sign: 'DEBIT', requiresReason: false },
  SALE_CREDIT: { sign: 'DEBIT', requiresReason: false },
  PAYMENT_RECEIVED: { sign: 'CREDIT', requiresReason: false },
  RETURN_CREDIT: { sign: 'CREDIT', requiresReason: false },
  SALE_CANCELLED: { sign: 'CREDIT', requiresReason: false },
  PAYMENT_REVERSED: { sign: 'DEBIT', requiresReason: true },
  ADJUSTMENT_DEBIT: { sign: 'DEBIT', requiresReason: true },
  ADJUSTMENT_CREDIT: { sign: 'CREDIT', requiresReason: true },
  WRITE_OFF: { sign: 'CREDIT', requiresReason: true },
} as const

export type LedgerEntryType = keyof typeof LEDGER_ENTRY_TYPES
export const LEDGER_ENTRY_TYPE_LIST = Object.keys(
  LEDGER_ENTRY_TYPES,
) as readonly LedgerEntryType[]

// --- Messaging -----------------------------------------------------------------------------

/**
 * Blueprint §20.1: `WA_DEEPLINK` is the MVP channel — ₹0 per message, no Meta verification, no
 * TRAI DLT registration, and the message arrives from the shopkeeper's own number. The server-sent
 * channels are built behind the same interface but gated by a feature flag.
 */
export const MESSAGE_CHANNELS = ['WA_DEEPLINK', 'WA_CLOUD', 'SMS'] as const
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number]

export const MESSAGE_STATUSES = [
  'QUEUED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'SKIPPED_QUOTA',
  'SKIPPED_NO_PHONE',
  'SKIPPED_OPTED_OUT',
] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

export const MESSAGE_TEMPLATE_KEYS = [
  'sale_receipt',
  'payment_received',
  'udhaar_reminder',
  'statement',
  'subscription_expiring',
] as const
export type MessageTemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[number]

// --- Sync ----------------------------------------------------------------------------------

export const SYNC_OP_TYPES = ['create', 'update', 'archive'] as const
export type SyncOpType = (typeof SYNC_OP_TYPES)[number]

/**
 * Blueprint §14.4. `duplicate` is a success — it means the idempotency ledger already had this
 * op_id and the stored result was returned. A client must treat it exactly like `applied`.
 */
export const SYNC_OP_STATUSES = ['applied', 'duplicate', 'conflict', 'rejected'] as const
export type SyncOpStatus = (typeof SYNC_OP_STATUSES)[number]

export const CONFLICT_RESOLUTIONS = ['server_wins', 'client_wins', 'manual'] as const
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number]

// --- Subscription --------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'GRACE',
  'CANCELLED',
  'EXPIRED',
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

// --- Audit ---------------------------------------------------------------------------------

export const AUDIT_ACTOR_TYPES = ['USER', 'PLATFORM_ADMIN', 'SYSTEM'] as const
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number]
