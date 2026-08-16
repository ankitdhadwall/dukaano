/**
 * Conflict resolution for mutable state (blueprint §14.7).
 *
 * Most of Dukaano never reaches this file. Sales, payments, ledger entries and inventory
 * transactions are **append-only immutable facts**, and two facts are simply two facts — there is
 * nothing to merge (§14.1). What remains is a small set of genuinely mutable rows: product,
 * customer, supplier. This module decides those.
 *
 * The rule that carries the money is **field-aware** last-write-wins:
 *
 *   • `sellingPrice` and `purchasePrice` are **server-wins** unless the client's edit is strictly
 *     newer than the server's *and* was made against the current `rowVersion`.
 *   • Every other field is plain last-write-wins on `clientUpdatedAt`, ties going to the server.
 *   • Archive status and derived state never come from a client at all.
 *
 * Why prices get the stricter rule: they are the only field where a stale offline overwrite is
 * *financially* harmful. A phone that has been in a drawer for a week, holding a price from before
 * a supplier increase, must not push that price back onto the shelf the moment it reconnects — the
 * shop would sell at a loss and nobody would know why. A stale product *name* overwriting a newer
 * one is an annoyance; a stale *price* is money walking out of the door.
 *
 * Nothing is ever dropped silently. Every field the server refuses is returned in `rejected`, and
 * the caller records a `sync_conflict` row that surfaces in the shopkeeper's conflict inbox.
 */

/** Fields a client may attempt to change on a product. */
export interface ProductPatch {
  nameEn?: string | null
  nameHi?: string | null
  sku?: string | null
  shortCode?: string | null
  categoryId?: string | null
  sellingPricePaise?: number
  purchasePricePaise?: number | null
  mrpPaise?: number | null
  lowStockThresholdMilli?: number
}

/** The server's view of the row being edited. */
export interface ServerProductState {
  readonly rowVersion: number
  /**
   * When the row was last changed, in the *client's* clock where one is known.
   *
   * A row last written online has no client time; `updatedAt` (server time) stands in. Mixing the
   * two clocks is unavoidable — the comparison has to happen in one timeline — and this is the
   * choice that makes an offline edit lose to a more recent online edit, which is the safer
   * direction: someone was demonstrably at the shop.
   */
  readonly effectiveUpdatedAt: Date
}

/** What the client is asking for. */
export interface ClientEdit {
  readonly patch: ProductPatch
  readonly clientUpdatedAt: Date
  /** The `rowVersion` the edit was made against. Undefined for a client that never saw the row. */
  readonly baseVersion?: number
}

export type RejectionReason =
  /** The server's copy is at least as new. Plain last-write-wins. */
  | 'STALE'
  /** A price edit made against an older row version — the stricter price rule. */
  | 'PRICE_NEEDS_CURRENT_VERSION'
  /** Never accepted from a client under any circumstances. */
  | 'SERVER_AUTHORITATIVE'

export interface RejectedField {
  readonly field: string
  readonly reason: RejectionReason
}

export interface ResolutionResult {
  /** Fields the server will apply. Empty when the client lost on everything. */
  readonly accepted: ProductPatch
  /** Fields refused, each with why. Drives the conflict inbox entry. */
  readonly rejected: readonly RejectedField[]
  /** True when anything was refused — the caller writes a `sync_conflict` row. */
  readonly hasConflict: boolean
}

/**
 * Fields where a stale overwrite costs money, so the client must prove it was up to date.
 *
 * `mrpPaise` is deliberately NOT here. MRP is printed on the packet — it is a fact the shopkeeper
 * is copying, not a decision they are making — so a stale MRP is a typo to correct, not a loss to
 * prevent. Guarding it would produce conflict-inbox noise for no financial benefit.
 */
export const PRICE_FIELDS = ['sellingPricePaise', 'purchasePricePaise'] as const

/**
 * Fields the server owns outright (§14.2, §14.7).
 *
 * A client that sends one of these is not malicious, it is out of date — the mobile app maps a
 * whole row into its patch and archive status rides along. It is refused rather than errored, and
 * the client refetches.
 */
export const SERVER_AUTHORITATIVE_FIELDS = [
  'archivedAt',
  'isActive',
  'rowVersion',
  'unitCode',
  'shopId',
  'masterProductId',
] as const

const isPriceField = (field: string): boolean =>
  (PRICE_FIELDS as readonly string[]).includes(field)

const isServerAuthoritative = (field: string): boolean =>
  (SERVER_AUTHORITATIVE_FIELDS as readonly string[]).includes(field)

/**
 * Resolve one client edit against the server's current row.
 *
 * Field by field rather than all-or-nothing, deliberately. A single patch routinely carries a
 * renamed product *and* a stale price; accepting or refusing the whole thing would either lose
 * the rename or apply the bad price. Per-field resolution keeps the part that is safe.
 */
export function resolveProductConflict(
  edit: ClientEdit,
  server: ServerProductState,
): ResolutionResult {
  const accepted: ProductPatch = {}
  const rejected: RejectedField[] = []

  // Strictly newer. A tie goes to the server: two writes on the same millisecond are far more
  // likely to be one clock being wrong than a genuine race, and the server's copy is the one
  // that has already been seen by everyone else.
  const clientIsNewer = edit.clientUpdatedAt.getTime() > server.effectiveUpdatedAt.getTime()
  const editedAgainstCurrentVersion = edit.baseVersion === server.rowVersion

  for (const [field, value] of Object.entries(edit.patch)) {
    if (value === undefined) continue

    if (isServerAuthoritative(field)) {
      rejected.push({ field, reason: 'SERVER_AUTHORITATIVE' })
      continue
    }

    if (!clientIsNewer) {
      rejected.push({ field, reason: 'STALE' })
      continue
    }

    if (isPriceField(field) && !editedAgainstCurrentVersion) {
      rejected.push({ field, reason: 'PRICE_NEEDS_CURRENT_VERSION' })
      continue
    }

    Object.assign(accepted, { [field]: value })
  }

  return { accepted, rejected, hasConflict: rejected.length > 0 }
}

/**
 * The E-31 asymmetry: what a since-demoted user's queued ops may still do.
 *
 * A cashier creates a sale offline. Before the phone reconnects, the owner removes their
 * permission. What happens to the queued op?
 *
 *   **Facts are accepted.** The goods left the shop and the money entered the till. Refusing the
 *   record does not undo either — it only means the shop's books no longer describe reality, and
 *   the cash drawer will not balance at closing.
 *
 *   **Edits, cancellations and adjustments are refused.** These change the *interpretation* of
 *   what happened, and accepting them from someone whose permission was just removed is exactly
 *   the abuse the removal was meant to stop. A dismissed cashier must not be able to cancel
 *   yesterday's sales from a phone they still hold.
 *
 * The asymmetry is the whole point, and it follows the §54 ordering directly: financial
 * correctness first, then auditability. Both branches are audited either way.
 */
export const APPEND_ONLY_ENTITIES = [
  'sale',
  'sale_item',
  'payment',
  'payment_allocation',
  'customer_ledger_entry',
  'inventory_transaction',
] as const

export function isAppendOnlyFact(entity: string, opType: string): boolean {
  return (
    (APPEND_ONLY_ENTITIES as readonly string[]).includes(entity) && opType.toLowerCase() === 'create'
  )
}

/**
 * May this op be applied, given the permission the user holds **now**?
 *
 * `hadPermissionWhenQueued` is not consulted and cannot be: the client asserts it, and a client
 * that can assert its own past authorization can assert anything. Authorization is always
 * evaluated against current server state (§14.2).
 */
export function authorizeQueuedOperation(input: {
  readonly entity: string
  readonly opType: string
  readonly holdsPermissionNow: boolean
}): { readonly allowed: boolean; readonly reason?: 'PERMISSION_REVOKED' } {
  if (input.holdsPermissionNow) return { allowed: true }

  // The asymmetry. A fact survives the permission change; an edit does not.
  if (isAppendOnlyFact(input.entity, input.opType)) return { allowed: true }

  return { allowed: false, reason: 'PERMISSION_REVOKED' }
}
