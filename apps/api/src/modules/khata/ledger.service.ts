import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  applyLedgerEntry,
  ledgerEntryRequiresReason,
  signedLedgerAmount,
} from '@dukaano/business-logic'
import type { LedgerEntryType } from '@dukaano/types'
import { BusinessRuleError, NotFoundError } from '../../common/errors/domain-error'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'
import { ChangeLogService } from '../sync/change-log.service'

export interface LedgerEntryRequest {
  readonly customerId: string
  readonly entryType: LedgerEntryType
  /** Always POSITIVE. The sign comes from the entry type (§18.1 rule 2). */
  readonly magnitudePaise: number
  readonly refType?: 'SALE' | 'PAYMENT' | 'SALE_RETURN'
  readonly refId?: string
  readonly reason?: string
  readonly note?: string
  readonly occurredAt?: Date
  readonly opId?: string
}

export interface LedgerEntryResult {
  readonly entryId: string
  readonly signedAmountPaise: number
  readonly balanceBeforePaise: number
  readonly balanceAfterPaise: number
}

/**
 * The customer ledger — the ONLY writer of `customer_ledger_entry` and `customer_balance`
 * (blueprint §18).
 *
 * The same shape as `InventoryService` and for the same reason: an append-only log with a locked
 * snapshot beside it, written in one place so `balance == Σ entries` has exactly one code path
 * that could break it.
 *
 * Three rules from §18.1 that this class exists to make unbreakable:
 *
 *   1. **Append-only.** No update, no delete. A mistake is corrected by appending a reversing
 *      entry, which is why the ledger can be shown to a customer as an explanation rather than a
 *      claim.
 *   2. **The sign comes from the entry type**, never from the caller. Callers pass a positive
 *      magnitude.
 *   3. **`balance_after_paise` is stamped inside the lock**, so replaying entries in insertion
 *      order reproduces a coherent running balance for a statement — even when two payments to the
 *      same customer land concurrently from two devices (§25 E-27).
 */
@Injectable()
export class LedgerService {
  constructor(private readonly changeLog: ChangeLogService) {}

  /**
   * Append one entry and move the balance, atomically.
   *
   * Runs inside the caller's transaction, so a `SALE_CREDIT` commits or rolls back with the sale
   * that caused it. There is no path that writes a ledger entry for a sale that does not exist.
   */
  async append(request: LedgerEntryRequest): Promise<LedgerEntryResult> {
    const context = currentContext()
    const shopId = context?.shopId
    if (!shopId) throw new Error('LedgerService.append requires a tenant context')

    if (ledgerEntryRequiresReason(request.entryType) && !request.reason?.trim()) {
      // Owner corrections and write-offs must say why. This is the entry a customer will one day
      // point at and ask about, and "no reason recorded" is not an answer.
      throw new BusinessRuleError(
        'REASON_REQUIRED',
        'errors.khata.reasonRequired',
        { type: request.entryType },
        `${request.entryType} requires a reason`,
      )
    }

    const signedAmountPaise = signedLedgerAmount(request.entryType, request.magnitudePaise)
    const tx = tenantClient()

    const before = await this.lockBalance(shopId, request.customerId)
    const after = applyLedgerEntry(before, signedAmountPaise)

    const entryId = randomUUID()
    await tx.customerLedgerEntry.create({
      data: {
        id: entryId,
        shopId,
        customerId: request.customerId,
        entryType: request.entryType,
        amountPaise: BigInt(signedAmountPaise),
        balanceAfterPaise: BigInt(after),
        refType: request.refType ?? null,
        refId: request.refId ?? null,
        reason: request.reason ?? null,
        note: request.note ?? null,
        actorUserId: context?.userId ?? null,
        deviceId: context?.deviceId ?? null,
        occurredAt: request.occurredAt ?? new Date(),
        opId: request.opId ?? null,
      },
    })

    await tx.customerBalance.update({
      where: { shopId_customerId: { shopId, customerId: request.customerId } },
      data: {
        outstandingPaise: BigInt(after),
        lastEntryId: entryId,
        lastActivityAt: new Date(),
        version: { increment: 1n },
      },
    })

    await this.changeLog.recordMany([
      { entity: 'customer_ledger_entry', entityId: entryId, op: 'upsert', rowVersion: 1 },
      { entity: 'customer_balance', entityId: request.customerId, op: 'upsert', rowVersion: 1 },
    ])

    return { entryId, signedAmountPaise, balanceBeforePaise: before, balanceAfterPaise: after }
  }

  /**
   * Lock the balance row, creating it if this customer has never transacted.
   *
   * `SELECT … FOR UPDATE` is what makes §25 E-27 work: two payments to the same customer arriving
   * at once serialize here, so both apply and the balance is their sum. Without it both read the
   * same starting balance and the second silently overwrites the first — the customer's money
   * received, recorded, and then erased.
   */
  private async lockBalance(shopId: string, customerId: string): Promise<number> {
    const tx = tenantClient()

    const rows = await tx.$queryRaw<{ outstanding_paise: bigint }[]>`
      SELECT outstanding_paise FROM customer_balance
      WHERE shop_id = ${shopId}::uuid AND customer_id = ${customerId}::uuid
      FOR UPDATE
    `
    if (rows[0]) return Number(rows[0].outstanding_paise)

    // First entry for this customer. ON CONFLICT makes it race-safe against a concurrent insert.
    await tx.$executeRaw`
      INSERT INTO customer_balance (shop_id, customer_id, outstanding_paise, version, updated_at)
      VALUES (${shopId}::uuid, ${customerId}::uuid, 0, 0, now())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `

    const created = await tx.$queryRaw<{ outstanding_paise: bigint }[]>`
      SELECT outstanding_paise FROM customer_balance
      WHERE shop_id = ${shopId}::uuid AND customer_id = ${customerId}::uuid
      FOR UPDATE
    `
    const row = created[0]
    if (!row) throw new Error(`Could not create a customer balance for ${customerId}`)
    return Number(row.outstanding_paise)
  }

  /**
   * A customer statement (§18.5).
   *
   * Sorted by `occurred_at` because that is the date the shopkeeper and customer both remember,
   * but the running balance follows **insertion order** — `balance_after_paise` as stamped. Those
   * two can disagree when an offline entry is backdated, and when they do, both dates are shown
   * rather than one being quietly recomputed to look tidy.
   */
  async statement(
    shopId: string,
    customerId: string,
    range?: { from?: Date; to?: Date },
  ) {
    /*
     * Confirm the customer exists in THIS shop before reading anything.
     *
     * Without it, a statement request for another shop's customer returned 200 with an empty
     * entry list — RLS correctly yielded no rows, so nothing leaked, but "empty" and "not yours"
     * became indistinguishable from "exists and has no history". §23.3 requires cross-tenant
     * access to be indistinguishable from absent, and 200-with-nothing is neither. The
     * tenant-isolation gate caught this on the day the route was written.
     */
    const customer = await tenantClient().customer.findFirst({
      where: { id: customerId, shopId },
      select: { id: true },
    })
    if (!customer) throw new NotFoundError('Customer', customerId)

    const entries = await tenantClient().customerLedgerEntry.findMany({
      where: {
        shopId,
        customerId,
        ...(range?.from || range?.to
          ? { occurredAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
          : {}),
      },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, entryType: true, amountPaise: true, balanceAfterPaise: true,
        refType: true, refId: true, reason: true, note: true,
        occurredAt: true, createdAt: true,
      },
    })

    const balance = await tenantClient().customerBalance.findUnique({
      where: { shopId_customerId: { shopId, customerId } },
      select: { outstandingPaise: true, lastActivityAt: true },
    })

    return {
      customerId,
      outstandingPaise: balance?.outstandingPaise ?? 0n,
      lastActivityAt: balance?.lastActivityAt ?? null,
      entries: entries.map((entry) => ({
        ...entry,
        // Surfaced so the client can show both dates when they disagree, rather than the client
        // having to compare two timestamps and guess whether the difference is meaningful.
        wasBackdated: entry.occurredAt.getTime() < entry.createdAt.getTime() - 60_000,
      })),
    }
  }

  /**
   * Reconciliation: does every balance equal the sum of its entries? (§18.1)
   *
   * Reports rather than heals, for the same reason the inventory sweep does: a mismatch means a
   * bug in the write path, and correcting the number would erase the evidence while leaving the
   * customer's visible history inconsistent with what they are told they owe.
   */
  async reconcile(shopId: string) {
    const mismatches = await tenantClient().$queryRaw<
      { customer_id: string; balance_paise: bigint; sum_paise: bigint }[]
    >`
      SELECT b.customer_id,
             b.outstanding_paise      AS balance_paise,
             coalesce(e.total, 0)     AS sum_paise
      FROM customer_balance b
      LEFT JOIN (
        SELECT customer_id, sum(amount_paise) AS total
        FROM customer_ledger_entry
        WHERE shop_id = ${shopId}::uuid
        GROUP BY customer_id
      ) e ON e.customer_id = b.customer_id
      WHERE b.shop_id = ${shopId}::uuid
        AND b.outstanding_paise <> coalesce(e.total, 0)
    `

    return { checkedAt: new Date(), mismatchCount: mismatches.length, mismatches }
  }
}
