import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { computeBusinessDate } from '@dukaano/business-logic'
import type { CreateReturnInput } from '@dukaano/validation'
import { BusinessRuleError, NotFoundError } from '../../common/errors/domain-error'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'
import { ChangeLogService } from '../sync/change-log.service'
import { InventoryService } from '../inventory/inventory.service'
import { LedgerService } from '../khata/ledger.service'

/**
 * Returns (blueprint §25 E-11, E-12, E-39).
 *
 * A return is its **own document**, not a mutation of the sale. The original bill is in the
 * customer's hand and must keep rendering exactly as printed, and "what came back, when, and who
 * accepted it" is a question the shopkeeper will be asked.
 *
 * **The order of operations is the whole edge case (E-39):**
 *
 *   1. reverse the credit portion first
 *   2. then refund cash, never exceeding what was actually paid
 *
 * Refunding cash first on a bill that was mostly udhaar hands over money the shop never received —
 * the customer returns ₹500 of goods they had taken on credit and walks out with ₹500 in cash,
 * while their khata balance stays exactly where it was. Doing credit first bounds what remains
 * refundable to what genuinely came in.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
    private readonly changeLog: ChangeLogService,
  ) {}

  async create(shopId: string, saleId: string, input: CreateReturnInput) {
    const context = currentContext()
    const userId = context?.userId
    if (!userId) throw new Error('A return requires an authenticated user')

    const tx = tenantClient()
    const returnId = input.id ?? randomUUID()

    const existing = await tx.saleReturn.findFirst({
      where: { id: returnId, shopId },
      select: { id: true },
    })
    if (existing) return this.findById(shopId, returnId)

    const sale = await tx.sale.findFirst({
      where: { id: saleId, shopId },
      include: { items: true },
    })
    if (!sale) throw new NotFoundError('Sale', saleId)

    if (sale.status === 'CANCELLED') {
      throw new BusinessRuleError(
        'SALE_CANCELLED',
        'errors.sale.alreadyCancelled',
        {},
        'This sale was cancelled; the goods and money were already returned',
      )
    }

    const alreadyReturned = await this.returnedQuantities(shopId, saleId)
    const lines = this.resolveLines(sale.items, alreadyReturned, input)
    const totalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0)

    /*
     * Split the refund: credit first, then cash (E-39).
     *
     * `creditOutstanding` is what this sale still has on the customer's khata. Reversing at most
     * that much means a bill already settled in cash refunds in cash, a bill still fully on credit
     * refunds entirely as credit, and a partly-paid bill splits in the safe direction.
     */
    const creditOutstanding = Number(sale.creditPaise)
    const refundCreditPaise = Math.min(totalPaise, creditOutstanding)
    const maxCashRefund = totalPaise - refundCreditPaise
    const requestedCash = input.refundCashPaise ?? maxCashRefund

    if (requestedCash > maxCashRefund) {
      throw new BusinessRuleError(
        'REFUND_EXCEEDS_PAID',
        'errors.sale.refundExceedsPaid',
        { max: maxCashRefund, requested: requestedCash },
        'Cash refunded may not exceed what was actually paid on this bill',
      )
    }

    const refundCashPaise = requestedCash
    // Anything the shopkeeper chose not to hand back in cash stays as credit, so the document
    // still satisfies `total = cash + credit` — the CHECK constraint behind it is the backstop.
    const finalCredit = totalPaise - refundCashPaise

    if (finalCredit > 0 && !sale.customerId) {
      throw new BusinessRuleError(
        'CUSTOMER_REQUIRED',
        'errors.sale.customerRequiredForCredit',
        {},
        'Credit cannot be reversed on a walk-in sale; refund the full amount in cash',
      )
    }

    const occurredAt = input.occurredAt ?? new Date()
    const businessDate = await this.businessDateFor(shopId, occurredAt)
    const returnNumber = await this.nextReturnNumber(shopId)

    await tx.saleReturn.create({
      data: {
        id: returnId,
        shopId,
        saleId,
        customerId: sale.customerId,
        returnNumber,
        totalPaise: BigInt(totalPaise),
        refundCashPaise: BigInt(refundCashPaise),
        refundCreditPaise: BigInt(finalCredit),
        reason: input.reason ?? null,
        businessDate,
        occurredAt,
        createdByUserId: userId,
        deviceId: context?.deviceId ?? null,
        opId: input.opId ?? null,
      },
    })

    await tx.saleReturnItem.createMany({
      data: lines.map((line) => ({
        id: randomUUID(),
        shopId,
        returnId,
        saleItemId: line.saleItemId,
        productId: line.productId,
        qtyMilli: BigInt(line.qtyMilli),
        // The price from the ORIGINAL bill. The refund must match what was charged, whatever the
        // product costs today.
        unitPricePaise: BigInt(line.unitPricePaise),
        lineTotalPaise: BigInt(line.lineTotalPaise),
      })),
    })

    // Goods back on the shelf.
    await this.inventory.applyMovements(
      lines.map((line) => ({
        productId: line.productId,
        type: 'CUSTOMER_RETURN' as const,
        qtyDeltaMilli: line.qtyMilli,
        refType: 'SALE_RETURN',
        refId: returnId,
        occurredAt,
      })),
    )

    // Credit reversed first.
    if (finalCredit > 0 && sale.customerId) {
      await this.ledger.append({
        customerId: sale.customerId,
        entryType: 'RETURN_CREDIT',
        magnitudePaise: finalCredit,
        refType: 'SALE_RETURN',
        refId: returnId,
        reason: input.reason,
        occurredAt,
      })
    }

    // Then cash out — a real movement of money, so a real payment row.
    let refundPaymentId: string | undefined
    if (refundCashPaise > 0) {
      refundPaymentId = randomUUID()
      const originalMethod = await tx.payment.findFirst({
        where: { shopId, saleId, direction: 'IN' },
        orderBy: { createdAt: 'asc' },
        select: { method: true },
      })

      await tx.payment.create({
        data: {
          id: refundPaymentId,
          shopId,
          customerId: sale.customerId,
          saleId,
          direction: 'OUT',
          // Refunded the way it was paid where we know how; cash otherwise. A UPI sale refunded
          // as "CASH" would misreport the drawer by the refund amount every time.
          method: originalMethod?.method ?? 'CASH',
          amountPaise: BigInt(refundCashPaise),
          note: `Return ${returnNumber}${input.reason ? `: ${input.reason}` : ''}`,
          businessDate,
          occurredAt,
          createdByUserId: userId,
          deviceId: context?.deviceId ?? null,
        },
      })
    }

    /*
     * The sale's own totals are NOT adjusted.
     *
     * `paid + credit = total` is a CHECK constraint, and those columns describe the bill as
     * issued — the customer's printed copy still says so. "What is still open on this bill?" is
     * derived instead, by subtracting non-reversed allocations and returned credit from
     * `credit_paise`; see the FIFO query in PaymentsService.
     */
    await tx.sale.update({
      where: { id: saleId },
      data: { rowVersion: { increment: 1n } },
    })

    await this.changeLog.recordMany([
      { entity: 'sale', entityId: saleId, op: 'upsert', rowVersion: 2 },
      ...(refundPaymentId
        ? [{ entity: 'payment' as const, entityId: refundPaymentId, op: 'upsert' as const, rowVersion: 1 }]
        : []),
    ])

    return this.findById(shopId, returnId)
  }

  async findById(shopId: string, id: string) {
    const saleReturn = await tenantClient().saleReturn.findFirst({
      where: { id, shopId },
      include: { items: true, sale: { select: { id: true, saleNumber: true } } },
    })
    if (!saleReturn) throw new NotFoundError('SaleReturn', id)
    return saleReturn
  }

  async listForSale(shopId: string, saleId: string) {
    // Same reasoning as the khata statement: an empty list for another shop's bill would make
    // "not yours" indistinguishable from "no returns yet", where §23.3 requires it to be
    // indistinguishable from "no such bill".
    const sale = await tenantClient().sale.findFirst({
      where: { id: saleId, shopId },
      select: { id: true },
    })
    if (!sale) throw new NotFoundError('Sale', saleId)

    return tenantClient().saleReturn.findMany({
      where: { shopId, saleId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    })
  }

  // --- internals ---------------------------------------------------------------------------------

  /**
   * Resolve requested lines against the original bill, capping at what is still returnable.
   *
   * Cumulative across every previous return on this sale, not just this one: three separate
   * returns of 1 kg each against a 2 kg purchase must fail on the third, and checking only the
   * current request would let a customer return more than they ever bought.
   */
  private resolveLines(
    saleItems: readonly {
      id: string
      productId: string
      qtyMilli: bigint
      unitPricePaise: bigint
      discountPaise: bigint
      lineTotalPaise: bigint
    }[],
    alreadyReturned: Map<string, number>,
    input: CreateReturnInput,
  ) {
    const byId = new Map(saleItems.map((item) => [item.id, item]))

    return input.items.map((requested) => {
      const item = byId.get(requested.saleItemId)
      if (!item) throw new NotFoundError('SaleItem', requested.saleItemId)

      const sold = Number(item.qtyMilli)
      const returned = alreadyReturned.get(item.id) ?? 0
      const returnable = sold - returned

      if (requested.qtyMilli > returnable) {
        throw new BusinessRuleError(
          'RETURN_EXCEEDS_SOLD',
          'errors.sale.returnExceedsSold',
          { returnable, requested: requested.qtyMilli },
          `Only ${returnable} milli-units of this line remain returnable`,
        )
      }

      /*
       * The refund is the line's *net* value per unit, discount included.
       *
       * Refunding the gross price on a discounted line hands back more than the customer paid, and
       * on a bill with a 20% line discount that is a fifth of the value walking out of the door.
       */
      const netPerUnit = Number(item.lineTotalPaise) / sold
      const lineTotalPaise = Math.round(netPerUnit * requested.qtyMilli)

      return {
        saleItemId: item.id,
        productId: item.productId,
        qtyMilli: requested.qtyMilli,
        unitPricePaise: Number(item.unitPricePaise),
        lineTotalPaise,
      }
    })
  }

  private async returnedQuantities(shopId: string, saleId: string): Promise<Map<string, number>> {
    const rows = await tenantClient().$queryRaw<{ sale_item_id: string; qty: bigint }[]>`
      SELECT ri.sale_item_id, sum(ri.qty_milli) AS qty
      FROM sale_return_item ri
      JOIN sale_return r ON r.shop_id = ri.shop_id AND r.id = ri.return_id
      WHERE ri.shop_id = ${shopId}::uuid AND r.sale_id = ${saleId}::uuid
      GROUP BY ri.sale_item_id
    `
    return new Map(rows.map((row) => [row.sale_item_id, Number(row.qty)]))
  }

  private async nextReturnNumber(shopId: string): Promise<string> {
    await tenantClient().$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${shopId}:return-number`}, 0))
    `
    const [row] = await tenantClient().$queryRaw<{ max_number: number | null }[]>`
      SELECT max(nullif(regexp_replace(return_number, '\\D', '', 'g'), '')::bigint) AS max_number
      FROM sale_return
      WHERE shop_id = ${shopId}::uuid AND return_number LIKE 'RET-%'
    `
    return `RET-${String(Number(row?.max_number ?? 0) + 1).padStart(4, '0')}`
  }

  private async businessDateFor(shopId: string, occurredAt: Date): Promise<Date> {
    const shop = await tenantClient().shop.findFirst({
      where: { id: shopId },
      select: { timezone: true, settings: { select: { businessDayStartHour: true } } },
    })
    const date = computeBusinessDate(
      occurredAt,
      shop?.timezone ?? 'Asia/Kolkata',
      shop?.settings?.businessDayStartHour ?? 0,
    )
    return new Date(`${date}T00:00:00.000Z`)
  }
}
