import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { allocateFifo, computeBusinessDate } from '@dukaano/business-logic'
import type { RecordPaymentInput, ReversePaymentInput } from '@dukaano/validation'
import { BusinessRuleError, NotFoundError } from '../../common/errors/domain-error'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'
import { ChangeLogService } from '../sync/change-log.service'
import { LedgerService } from './ledger.service'

/**
 * Khata collections and payment reversals (blueprint §18.4, §19.3).
 *
 * A payment row is **real money moving** (§19.1). Udhaar never appears here — it is a ledger
 * entry, written by the sales path. Every row in this table is cash, UPI, card or bank transfer
 * that actually changed hands, which is what makes the cash-drawer figure trustworthy and keeps
 * credit out of revenue.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly changeLog: ChangeLogService,
  ) {}

  /**
   * Record money received against a customer's outstanding balance.
   *
   * The order of operations matters and is fixed:
   *   1. write the payment — the money arrived, and that fact is recorded first
   *   2. allocate it across open bills, oldest first, so "which bills are still open?" stays
   *      answerable and the ageing report has something to work from
   *   3. append a `PAYMENT_RECEIVED` ledger entry, which is what actually moves the balance
   *
   * A payment that exceeds what is owed is an **advance**, not an error (§25 E-33). The balance
   * goes negative and the UI shows "जमा / advance". Refusing it would mean telling a customer the
   * shop cannot accept their money.
   */
  async record(shopId: string, input: RecordPaymentInput) {
    const context = currentContext()
    const userId = context?.userId
    if (!userId) throw new Error('A payment requires an authenticated user')

    const tx = tenantClient()
    const paymentId = input.id ?? randomUUID()

    // Idempotent on the client-generated id, so a retried offline op does not credit twice.
    const existing = await tx.payment.findFirst({
      where: { id: paymentId, shopId },
      select: { id: true },
    })
    if (existing) return this.findById(shopId, paymentId)

    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, shopId },
      select: { id: true },
    })
    if (!customer) throw new NotFoundError('Customer', input.customerId)

    const occurredAt = input.occurredAt ?? new Date()
    const businessDate = await this.businessDateFor(shopId, occurredAt)

    await tx.payment.create({
      data: {
        id: paymentId,
        shopId,
        customerId: input.customerId,
        // NULL saleId + a customer = a khata collection spread across bills, rather than a tender
        // against one bill at the counter.
        saleId: null,
        direction: 'IN',
        method: input.method,
        amountPaise: BigInt(input.amountPaise),
        reference: input.reference ?? null,
        note: input.note ?? null,
        businessDate,
        occurredAt,
        createdByUserId: userId,
        deviceId: context?.deviceId ?? null,
        opId: input.opId ?? null,
      },
    })

    const allocations = input.allocations
      ? await this.applyManualAllocations(shopId, paymentId, input)
      : await this.applyFifoAllocations(shopId, paymentId, input)

    const ledgerResult = await this.ledger.append({
      customerId: input.customerId,
      entryType: 'PAYMENT_RECEIVED',
      magnitudePaise: input.amountPaise,
      refType: 'PAYMENT',
      refId: paymentId,
      note: input.note,
      occurredAt,
    })

    await this.changeLog.record({ entity: 'payment', entityId: paymentId, op: 'upsert', rowVersion: 1 })

    return {
      ...(await this.findById(shopId, paymentId)),
      allocations,
      balanceAfterPaise: ledgerResult.balanceAfterPaise,
      /** Negative balance = the shop holds an advance for this customer. Shown, not warned about. */
      isAdvance: ledgerResult.balanceAfterPaise < 0,
    }
  }

  /**
   * Reverse a payment (§19.3).
   *
   * Never an edit and never a delete. A bounced cheque or a mis-keyed amount produces a *new*
   * reversing row; the original stays visible, marked reversed, pointing at its reversal. A
   * shopkeeper showing a customer their khata must be able to say "this payment came in and then
   * bounced" rather than having the entry simply not be there.
   */
  async reverse(shopId: string, paymentId: string, input: ReversePaymentInput) {
    const context = currentContext()
    const tx = tenantClient()

    const original = await tx.payment.findFirst({
      where: { id: paymentId, shopId },
      select: {
        id: true, customerId: true, saleId: true, method: true, amountPaise: true,
        direction: true, reversedByPaymentId: true, businessDate: true,
      },
    })
    if (!original) throw new NotFoundError('Payment', paymentId)

    if (original.reversedByPaymentId) {
      throw new BusinessRuleError(
        'ALREADY_REVERSED',
        'errors.payment.alreadyReversed',
        {},
        'This payment has already been reversed',
      )
    }
    if (original.direction !== 'IN') {
      throw new BusinessRuleError(
        'NOT_REVERSIBLE',
        'errors.payment.notReversible',
        {},
        'Only incoming payments can be reversed',
      )
    }

    const reversalId = randomUUID()
    await tx.payment.create({
      data: {
        id: reversalId,
        shopId,
        customerId: original.customerId,
        saleId: original.saleId,
        direction: 'OUT',
        method: original.method,
        amountPaise: original.amountPaise,
        note: input.reason,
        businessDate: original.businessDate,
        occurredAt: new Date(),
        createdByUserId: context?.userId ?? '',
        reversalOfPaymentId: paymentId,
      },
    })

    await tx.payment.update({
      where: { id: paymentId },
      data: { reversedByPaymentId: reversalId },
    })

    /*
     * The allocations are deliberately NOT deleted.
     *
     * The first version of this removed them, reasoning that a bill should stop looking settled by
     * money the shop no longer has. Two things say otherwise. The application role holds no DELETE
     * grant on `payment_allocation` — the allowlist in the RLS migration is narrow on purpose, and
     * it refused. And on reflection it is right to refuse: an allocation records what the payment
     * cleared *at the time*, which stays true even after the cheque bounced.
     *
     * Instead, every query that asks "what is still open on this bill?" ignores allocations whose
     * payment has been reversed. Nothing is destroyed, and the history reads correctly.
     */
    if (original.customerId) {
      await this.ledger.append({
        customerId: original.customerId,
        entryType: 'PAYMENT_REVERSED',
        magnitudePaise: Number(original.amountPaise),
        refType: 'PAYMENT',
        refId: reversalId,
        reason: input.reason,
      })
    }

    await this.changeLog.recordMany([
      { entity: 'payment', entityId: paymentId, op: 'upsert', rowVersion: 2 },
      { entity: 'payment', entityId: reversalId, op: 'upsert', rowVersion: 1 },
    ])

    return this.findById(shopId, reversalId)
  }

  async findById(shopId: string, id: string) {
    const payment = await tenantClient().payment.findFirst({
      where: { id, shopId },
      include: {
        allocations: { select: { saleId: true, amountPaise: true } },
        customer: { select: { id: true, name: true } },
      },
    })
    if (!payment) throw new NotFoundError('Payment', id)
    return payment
  }

  async list(shopId: string, filters: { customerId?: string; from?: Date; to?: Date; limit?: number }) {
    return tenantClient().payment.findMany({
      where: {
        shopId,
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
        ...(filters.from || filters.to
          ? {
              businessDate: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(filters.limit ?? 50, 200),
      select: {
        id: true, direction: true, method: true, amountPaise: true, reference: true,
        businessDate: true, occurredAt: true, saleId: true,
        reversedByPaymentId: true, reversalOfPaymentId: true,
        customer: { select: { id: true, name: true } },
      },
    })
  }

  /**
   * The cash-drawer figure (§19.4): how much cash should be in the till for a business date.
   *
   * Already answerable from `payment` alone because credit never produces a payment row — which is
   * §19.1 paying for itself. If udhaar were a payment method, this number would include money the
   * shop never received, and the shopkeeper would be short every evening with no idea why.
   */
  async dayTotals(shopId: string, businessDate: Date) {
    return tenantClient().$queryRaw<
      { method: string; direction: string; total_paise: bigint; count: bigint }[]
    >`
      -- The ::bigint casts are load-bearing. Postgres widens sum(bigint) to numeric, which Prisma
      -- maps to a Decimal object; the response serializer only converts BigInt, so the drawer
      -- figure silently reaches the client as NaN instead of a number.
      SELECT method, direction, sum(amount_paise)::bigint AS total_paise, count(*)::bigint AS count
      FROM payment
      WHERE shop_id = ${shopId}::uuid AND business_date = ${businessDate}
      GROUP BY method, direction
      ORDER BY method, direction
    `
  }

  // --- internals ---------------------------------------------------------------------------------

  /** Oldest bill first (§18.4) — what a shopkeeper means by "the old one is cleared". */
  private async applyFifoAllocations(shopId: string, paymentId: string, input: RecordPaymentInput) {
    const openBills = await tenantClient().$queryRaw<
      { sale_id: string; outstanding_paise: bigint }[]
    >`
      SELECT s.id AS sale_id,
             s.credit_paise - coalesce(a.allocated, 0) - coalesce(rt.returned, 0) AS outstanding_paise
      FROM sale s
      LEFT JOIN (
        -- Allocations from reversed payments are excluded: the money came back, so the bill is
        -- open again. The allocation row itself stays, because it is true that it once cleared it.
        SELECT al.sale_id, sum(al.amount_paise) AS allocated
        FROM payment_allocation al
        JOIN payment pay ON pay.shop_id = al.shop_id AND pay.id = al.payment_id
        WHERE al.shop_id = ${shopId}::uuid AND pay.reversed_by_payment_id IS NULL
        GROUP BY al.sale_id
      ) a ON a.sale_id = s.id
      LEFT JOIN (
        -- Credit reversed by a return also reduces what is still owed on the bill.
        SELECT r.sale_id, sum(r.refund_credit_paise) AS returned
        FROM sale_return r
        WHERE r.shop_id = ${shopId}::uuid
        GROUP BY r.sale_id
      ) rt ON rt.sale_id = s.id
      WHERE s.shop_id = ${shopId}::uuid
        AND s.customer_id = ${input.customerId}::uuid
        AND s.status = 'COMPLETED'
        AND s.credit_paise - coalesce(a.allocated, 0) - coalesce(rt.returned, 0) > 0
      ORDER BY s.business_date, s.occurred_at, s.id
    `

    const result = allocateFifo(
      input.amountPaise,
      openBills.map((bill) => ({
        saleId: bill.sale_id,
        outstandingPaise: Number(bill.outstanding_paise),
      })),
    )

    await this.writeAllocations(shopId, paymentId, result.allocations)
    return { ...result }
  }

  /** A manual override from the web admin. Validated: it may not exceed the payment. */
  private async applyManualAllocations(shopId: string, paymentId: string, input: RecordPaymentInput) {
    const allocations = input.allocations ?? []
    const total = allocations.reduce((sum, a) => sum + a.amountPaise, 0)

    if (total > input.amountPaise) {
      throw new BusinessRuleError(
        'OVER_ALLOCATED',
        'errors.payment.overAllocated',
        { allocated: total, amount: input.amountPaise },
        'Allocations exceed the payment amount',
      )
    }

    await this.writeAllocations(shopId, paymentId, allocations)
    return { allocations, unallocatedPaise: input.amountPaise - total }
  }

  private async writeAllocations(
    shopId: string,
    paymentId: string,
    allocations: readonly { saleId: string; amountPaise: number }[],
  ) {
    if (allocations.length === 0) return
    await tenantClient().paymentAllocation.createMany({
      data: allocations.map((allocation) => ({
        id: randomUUID(),
        shopId,
        paymentId,
        saleId: allocation.saleId,
        amountPaise: BigInt(allocation.amountPaise),
      })),
    })
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
