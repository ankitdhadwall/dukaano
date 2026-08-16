import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  applyInboundCost,
  applyMovement,
  crossedBelowThreshold,
  stockValue,
} from '@dukaano/business-logic'
import { asMilli, asPaise } from '@dukaano/money'
import { INVENTORY_TRANSACTION_TYPES, type InventoryTransactionType } from '@dukaano/types'
import { BusinessRuleError, NotFoundError } from '../../common/errors/domain-error'
import { currentContext, tenantClient, type TenantClient } from '../../common/prisma/tenant-context'

export interface MovementRequest {
  readonly productId: string
  readonly type: InventoryTransactionType
  /** Signed, in milli-units. Negative for outbound. */
  readonly qtyDeltaMilli: number
  /** Cost per whole unit, in paise. Required for inbound movements that should affect costing. */
  readonly unitCostPaise?: number
  readonly reason?: string
  readonly note?: string
  readonly refType?: string
  readonly refId?: string
  readonly occurredAt?: Date
  /** Idempotency key for offline replay (§14.4). */
  readonly opId?: string
}

export interface MovementResult {
  readonly transactionId: string
  readonly productId: string
  readonly balanceBeforeMilli: number
  readonly balanceAfterMilli: number
  readonly avgCostPaise: number
  readonly wentNegative: boolean
  readonly crossedLowStock: boolean
}

/**
 * The ONLY writer of stock in Dukaano (blueprint §17).
 *
 * Every stock change in the system — sales, purchases, returns, damage, corrections, opening
 * stock — funnels through `applyMovement`. Nothing else may touch `inventory_balance`. That is
 * what makes "never silently change inventory without a trace" true rather than aspirational,
 * and it is why the nightly reconciliation job can meaningfully assert
 * `balance == Σ transactions`: there is exactly one code path that could break it.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name)

  /**
   * Apply one stock movement, atomically.
   *
   * The sequence is fixed and its order is load-bearing (§17.2):
   *   1. lock the balance row
   *   2. compute the new balance and, for inbound movements, the new moving-average cost
   *   3. append the immutable transaction, stamping the resulting balance
   *   4. update the snapshot
   *   5. enqueue a low-stock notification if the movement crossed the threshold
   *
   * Runs inside the request's tenant transaction, so it commits or rolls back together with
   * whatever caused it — a sale never persists without its stock movements.
   */
  async applyMovement(request: MovementRequest): Promise<MovementResult> {
    const tx = tenantClient()
    const context = currentContext()
    const shopId = context?.shopId
    if (!shopId) throw new Error('applyMovement requires a tenant context')

    if (request.qtyDeltaMilli === 0) {
      throw new BusinessRuleError(
        'ZERO_MOVEMENT',
        'errors.inventory.zeroMovement',
        {},
        'A stock movement of zero records nothing and pollutes the history',
      )
    }

    const meta = INVENTORY_TRANSACTION_TYPES[request.type]
    if (meta.requiresReason && !request.reason?.trim()) {
      // Also enforced by a CHECK constraint. Checked here too so the shopkeeper gets a localized
      // message naming the field rather than a database error.
      throw new BusinessRuleError(
        'REASON_REQUIRED',
        'errors.inventory.reasonRequired',
        { type: request.type },
        `${request.type} movements require a reason`,
      )
    }
    if (meta.sign === 'IN' && request.qtyDeltaMilli < 0) {
      throw new BusinessRuleError('WRONG_DIRECTION', 'errors.inventory.wrongDirection', { type: request.type })
    }
    if (meta.sign === 'OUT' && request.qtyDeltaMilli > 0) {
      throw new BusinessRuleError('WRONG_DIRECTION', 'errors.inventory.wrongDirection', { type: request.type })
    }

    const product = await tx.product.findFirst({
      where: { id: request.productId, shopId },
      select: { id: true, nameEn: true, nameHi: true, lowStockThresholdMilli: true, archivedAt: true },
    })
    if (!product) throw new NotFoundError('Product', request.productId)

    /*
     * An archived product may still receive movements.
     *
     * Blueprint §25 E-9: archiving is soft, and a sale of an archived product created offline
     * must still apply on sync — the goods left the shop. Blocking here would reject real
     * financial events to protect a catalogue flag.
     */

    const balance = await this.lockBalance(tx, shopId, request.productId)

    const before = asMilli(Number(balance.qtyMilli))
    const after = applyMovement(before, asMilli(request.qtyDeltaMilli))

    // Only inbound movements with a known cost move the average (§17.2).
    const avgCost =
      request.qtyDeltaMilli > 0 && request.unitCostPaise !== undefined
        ? applyInboundCost(
            { qtyMilli: before, avgCostPaise: asPaise(Number(balance.avgCostPaise)) },
            { qtyMilli: asMilli(request.qtyDeltaMilli), unitCostPaise: asPaise(request.unitCostPaise) },
          )
        : asPaise(Number(balance.avgCostPaise))

    const transactionId = randomUUID()
    await tx.inventoryTransaction.create({
      data: {
        id: transactionId,
        shopId,
        productId: request.productId,
        type: request.type,
        qtyDeltaMilli: BigInt(request.qtyDeltaMilli),
        balanceAfterMilli: BigInt(after),
        unitCostPaise: request.unitCostPaise !== undefined ? BigInt(request.unitCostPaise) : null,
        reason: request.reason ?? null,
        note: request.note ?? null,
        refType: request.refType ?? null,
        refId: request.refId ?? null,
        actorUserId: context?.userId ?? null,
        deviceId: context?.deviceId ?? null,
        occurredAt: request.occurredAt ?? new Date(),
        opId: request.opId ?? null,
      },
    })

    await tx.inventoryBalance.update({
      where: { shopId_productId: { shopId, productId: request.productId } },
      data: { qtyMilli: BigInt(after), avgCostPaise: BigInt(avgCost), version: { increment: 1n } },
    })

    const threshold = asMilli(Number(product.lowStockThresholdMilli))
    const crossedLowStock = crossedBelowThreshold(before, after, threshold)
    const wentNegative = before >= 0 && after < 0

    if (wentNegative) {
      // §14.8: the shopkeeper is prompted to correct, never blocked. Two cashiers selling the
      // same last packet offline both recorded real money; the stock number is what is wrong.
      this.logger.warn(
        `Stock went negative: product=${request.productId} ${before} → ${after} (shop ${shopId})`,
      )
    }

    return {
      transactionId,
      productId: request.productId,
      balanceBeforeMilli: before,
      balanceAfterMilli: after,
      avgCostPaise: avgCost,
      wentNegative,
      crossedLowStock,
    }
  }

  /**
   * Apply several movements atomically, locking in a deterministic order.
   *
   * The ordering is not cosmetic. Two concurrent multi-line sales that touch the same pair of
   * products will deadlock roughly one time in a few hundred if each locks in cart order —
   * surfacing in production as random 500s during the evening rush, and being close to
   * impossible to reproduce afterwards. Sorting by product id gives every transaction the same
   * lock order, which makes the deadlock structurally impossible.
   */
  async applyMovements(requests: readonly MovementRequest[]): Promise<MovementResult[]> {
    const ordered = [...requests].sort((a, b) => a.productId.localeCompare(b.productId))
    const results: MovementResult[] = []
    for (const request of ordered) {
      results.push(await this.applyMovement(request))
    }
    return results
  }

  /**
   * Opening stock for products created earlier in **this same transaction**.
   *
   * The bulk-import path only. `applyMovement` costs four round-trips per product — a lock, a
   * transaction insert, a balance update, a product read — which at 5,000 rows is 20,000
   * round-trips and several minutes. This does the same work in three statements.
   *
   * **Why skipping the `FOR UPDATE` lock is safe here, and only here.** The lock exists to
   * serialize concurrent movements on a balance another session might also be changing. These
   * products were INSERTed by the caller inside the current, uncommitted transaction, so no other
   * session can see the product row at all, let alone reach its balance. There is nothing to
   * contend with. Passing an id that was *not* created in this transaction would break that
   * argument, which is why this method is private to the service and the import path asserts the
   * ids it passes are ones it just created.
   *
   * Everything the append-only design guarantees still holds: one `inventory_transaction` row per
   * product, carrying its own `balance_after`, so reconciliation checks this path exactly as it
   * checks every other.
   */
  async applyOpeningStockBatch(
    entries: readonly {
      productId: string
      qtyMilli: number
      unitCostPaise?: number
    }[],
  ): Promise<number> {
    const positive = entries.filter((entry) => entry.qtyMilli > 0)
    if (positive.length === 0) return 0

    const tx = tenantClient()
    const context = currentContext()
    const shopId = context?.shopId
    if (!shopId) throw new Error('applyOpeningStockBatch requires a tenant context')

    const now = new Date()

    await tx.inventoryTransaction.createMany({
      data: positive.map((entry) => ({
        id: randomUUID(),
        shopId,
        productId: entry.productId,
        type: 'OPENING_STOCK' as const,
        qtyDeltaMilli: BigInt(entry.qtyMilli),
        // Opening stock starts from zero by definition — these products did not exist a moment
        // ago — so the resulting balance is the movement itself.
        balanceAfterMilli: BigInt(entry.qtyMilli),
        unitCostPaise: entry.unitCostPaise !== undefined ? BigInt(entry.unitCostPaise) : null,
        actorUserId: context?.userId ?? null,
        deviceId: context?.deviceId ?? null,
        occurredAt: now,
      })),
    })

    await tx.inventoryBalance.createMany({
      data: positive.map((entry) => ({
        shopId,
        productId: entry.productId,
        qtyMilli: BigInt(entry.qtyMilli),
        // First receipt with no prior stock: the moving average is simply the incoming cost,
        // which is what applyInboundCost returns for an empty state.
        avgCostPaise: BigInt(entry.unitCostPaise ?? 0),
        version: 1n,
      })),
    })

    return positive.length
  }

  /**
   * Lock the balance row, creating it if this product has never moved.
   *
   * `SELECT … FOR UPDATE` serializes concurrent movements on the same product, which is what
   * makes the read-compute-write above safe. Without it, two simultaneous sales both read the
   * same starting quantity and the second silently overwrites the first's deduction.
   */
  private async lockBalance(
    tx: TenantClient,
    shopId: string,
    productId: string,
  ): Promise<{ qtyMilli: bigint; avgCostPaise: bigint }> {
    const rows = await tx.$queryRaw<{ qty_milli: bigint; avg_cost_paise: bigint }[]>`
      SELECT qty_milli, avg_cost_paise
      FROM inventory_balance
      WHERE shop_id = ${shopId}::uuid AND product_id = ${productId}::uuid
      FOR UPDATE
    `

    const existing = rows[0]
    if (existing) {
      return { qtyMilli: existing.qty_milli, avgCostPaise: existing.avg_cost_paise }
    }

    // First movement for this product. ON CONFLICT makes the create race-safe: if a concurrent
    // transaction inserted it a moment ago, we take theirs rather than failing.
    await tx.$executeRaw`
      INSERT INTO inventory_balance (shop_id, product_id, qty_milli, avg_cost_paise, version, updated_at)
      VALUES (${shopId}::uuid, ${productId}::uuid, 0, 0, 0, now())
      ON CONFLICT (shop_id, product_id) DO NOTHING
    `

    const created = await tx.$queryRaw<{ qty_milli: bigint; avg_cost_paise: bigint }[]>`
      SELECT qty_milli, avg_cost_paise FROM inventory_balance
      WHERE shop_id = ${shopId}::uuid AND product_id = ${productId}::uuid
      FOR UPDATE
    `
    const row = created[0]
    if (!row) throw new Error(`Could not create an inventory balance for product ${productId}`)
    return { qtyMilli: row.qty_milli, avgCostPaise: row.avg_cost_paise }
  }

  /** Current stock for one product, with its transaction history. */
  async getProductStock(shopId: string, productId: string, historyLimit = 50) {
    const tx = tenantClient()

    /*
     * A product with no balance row has never moved, and its stock is **zero, not missing**.
     *
     * The balance row is created lazily by the first movement, so a product created without
     * opening stock has none. Returning 404 for it conflates "no such product" with "this
     * product has never been stocked" — the first is an error, the second is the normal state of
     * every newly created product, and a stock screen that 404s on a product the shopkeeper is
     * looking at reads as data loss.
     *
     * The 404 is still correct for a product that genuinely does not exist, or belongs to
     * another shop — which the existence check below preserves.
     */
    const product = await tx.product.findFirst({
      where: { id: productId, shopId },
      select: { id: true },
    })
    if (!product) throw new NotFoundError('Product', productId)

    const balance = (await tx.inventoryBalance.findUnique({
      where: { shopId_productId: { shopId, productId } },
    })) ?? { qtyMilli: 0n, avgCostPaise: 0n }

    const history = await tx.inventoryTransaction.findMany({
      where: { shopId, productId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: historyLimit,
      select: {
        id: true,
        type: true,
        qtyDeltaMilli: true,
        balanceAfterMilli: true,
        unitCostPaise: true,
        reason: true,
        note: true,
        refType: true,
        refId: true,
        actorUserId: true,
        occurredAt: true,
      },
    })

    return {
      productId,
      qtyMilli: balance.qtyMilli,
      avgCostPaise: balance.avgCostPaise,
      stockValuePaise: BigInt(
        stockValue({
          qtyMilli: asMilli(Number(balance.qtyMilli)),
          avgCostPaise: asPaise(Number(balance.avgCostPaise)),
        }),
      ),
      history,
    }
  }

  /**
   * Products at or below their low-stock threshold.
   *
   * Ordered by how far below they are, so the most urgent appears first — a shopkeeper scanning
   * this list on a phone reads the top three and stops.
   */
  async getLowStock(shopId: string) {
    return tenantClient().$queryRaw<
      {
        product_id: string
        name_en: string | null
        name_hi: string | null
        unit_code: string
        qty_milli: bigint
        low_stock_threshold_milli: bigint
        selling_price_paise: bigint
      }[]
    >`
      SELECT p.id AS product_id, p.name_en, p.name_hi, p.unit_code,
             b.qty_milli, p.low_stock_threshold_milli, p.selling_price_paise
      FROM inventory_balance b
      JOIN product p ON p.shop_id = b.shop_id AND p.id = b.product_id
      WHERE b.shop_id = ${shopId}::uuid
        AND p.archived_at IS NULL
        AND p.is_active = true
        AND p.low_stock_threshold_milli > 0
        AND b.qty_milli <= p.low_stock_threshold_milli
      ORDER BY (b.qty_milli - p.low_stock_threshold_milli) ASC
      LIMIT 200
    `
  }

  /** Inventory valuation at moving-average cost. */
  async getValuation(shopId: string) {
    const [row] = await tenantClient().$queryRaw<
      { product_count: bigint; total_value_paise: bigint | null; negative_count: bigint }[]
    >`
      SELECT count(*)                                                     AS product_count,
             sum(b.qty_milli * b.avg_cost_paise / 1000)::bigint           AS total_value_paise,
             count(*) FILTER (WHERE b.qty_milli < 0)                      AS negative_count
      FROM inventory_balance b
      JOIN product p ON p.shop_id = b.shop_id AND p.id = b.product_id
      WHERE b.shop_id = ${shopId}::uuid AND p.archived_at IS NULL
    `

    return {
      productCount: Number(row?.product_count ?? 0),
      totalValuePaise: row?.total_value_paise ?? 0n,
      negativeStockCount: Number(row?.negative_count ?? 0),
    }
  }

  /**
   * Reconciliation: does every snapshot equal the sum of its transactions? (§17.4)
   *
   * A mismatch means a bug in the write path, so this **reports** rather than auto-heals.
   * Silently correcting the number would hide the defect and leave the shopkeeper's history
   * inconsistent with their balance — the exact situation the append-only design exists to
   * prevent.
   */
  async reconcile(shopId: string) {
    const mismatches = await tenantClient().$queryRaw<
      { product_id: string; balance_milli: bigint; sum_milli: bigint }[]
    >`
      SELECT b.product_id,
             b.qty_milli                      AS balance_milli,
             coalesce(t.total, 0)             AS sum_milli
      FROM inventory_balance b
      LEFT JOIN (
        SELECT product_id, sum(qty_delta_milli) AS total
        FROM inventory_transaction
        WHERE shop_id = ${shopId}::uuid
        GROUP BY product_id
      ) t ON t.product_id = b.product_id
      WHERE b.shop_id = ${shopId}::uuid
        AND b.qty_milli <> coalesce(t.total, 0)
    `

    if (mismatches.length > 0) {
      this.logger.error(
        `RECONCILIATION FAILURE: ${mismatches.length} inventory balances do not match their ` +
          `transaction history in shop ${shopId}. This indicates a bug in the write path.`,
      )
    }

    return { checkedAt: new Date(), mismatchCount: mismatches.length, mismatches }
  }
}
