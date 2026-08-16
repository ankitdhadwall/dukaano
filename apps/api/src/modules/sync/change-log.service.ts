import { Injectable } from '@nestjs/common'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'

/**
 * The delta-pull feed (blueprint §14.5).
 *
 * Every tenant write appends a row here **in the same transaction as the write itself**. That is
 * the whole guarantee: a product that exists but was never logged is a product that silently
 * never reaches a shopkeeper's phone, and no error is raised anywhere. Because the request already
 * runs inside one tenant transaction (`TenantTransactionInterceptor`), "same transaction" is free
 * — `tenantClient()` is that transaction — but it is only free if the call is actually made, which
 * is why `sync-coverage.spec.ts` performs every syncable mutation over HTTP and asserts a row
 * appeared. Forgetting the call is the realistic failure, not getting the transaction wrong.
 *
 * `txid` is not set here. It comes from the column default `pg_current_xact_id()`, so it is the
 * transaction's real id rather than anything application code could get wrong.
 */

/** Entities a device replicates. */
export const SYNCABLE_ENTITIES = [
  'product',
  'product_alias',
  'category',
  'customer',
  'supplier',
  'inventory_balance',
  'inventory_transaction',
  'shop_settings',
  // Phase 4 — billing. `sale_item` and `payment_allocation` are deliberately absent: they are
  // children that never change independently of their parent, so a device applies them from the
  // parent's payload. Logging them separately would triple the change volume of every sale for
  // no additional information.
  'sale',
  'sale_return',
  'payment',
  'customer_ledger_entry',
  'customer_balance',
] as const

export type SyncableEntity = (typeof SYNCABLE_ENTITIES)[number]

/** `upsert` covers create and update alike — the client applies both as an idempotent upsert. */
export type ChangeOp = 'upsert' | 'archive'

export interface ChangeRecord {
  readonly entity: SyncableEntity
  readonly entityId: string
  readonly op: ChangeOp
  /**
   * The row's version after the change.
   *
   * Part of the client's apply key `(entity, id, row_version)`, which is what makes a re-served
   * change harmless. Rows without their own version counter (inventory_balance keeps `version`,
   * inventory_transaction is immutable) pass 1.
   */
  readonly rowVersion: number | bigint
}

@Injectable()
export class ChangeLogService {
  /** Record one change. Call inside the transaction that made it. */
  async record(change: ChangeRecord): Promise<void> {
    await this.recordMany([change])
  }

  /**
   * Record many changes in one statement.
   *
   * The bulk import creates 5,000 products; 5,000 individual inserts would dominate its runtime
   * and is the difference between an import that takes under a second and one that takes a minute.
   */
  async recordMany(changes: readonly ChangeRecord[]): Promise<void> {
    if (changes.length === 0) return

    const shopId = currentContext()?.shopId
    if (!shopId) {
      // Loud rather than silent. A change written with no tenant context would be invisible to
      // RLS and therefore to every device — the exact silent-loss failure this table prevents.
      throw new Error('ChangeLogService.record requires a tenant context')
    }

    /*
     * Raw SQL rather than `createMany`, for a schema reason rather than a performance one.
     *
     * `change_log.txid` is `Unsupported("xid8")` — Prisma cannot model the type, so it appears in
     * the generated create input as a required field it has no way to produce. The value must come
     * from the column default `pg_current_xact_id()` anyway: it has to be *this transaction's* id,
     * which only the database can supply correctly.
     *
     * `unnest` turns the batch into a single statement with four parameter arrays, so 5,000
     * imported products cost one round trip. Fully parameterized, per §23.5.
     */
    await tenantClient().$executeRaw`
      INSERT INTO change_log (shop_id, entity, entity_id, op, row_version)
      SELECT ${shopId}::uuid, c.entity, c.entity_id::uuid, c.op, c.row_version::bigint
      FROM unnest(
        ${changes.map((c) => c.entity)}::text[],
        ${changes.map((c) => c.entityId)}::text[],
        ${changes.map((c) => c.op)}::text[],
        ${changes.map((c) => String(c.rowVersion))}::text[]
      ) AS c(entity, entity_id, op, row_version)
    `
  }
}
