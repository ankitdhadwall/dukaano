import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ageingBucket } from '@dukaano/business-logic'
import { normalizeIndianPhone } from '@dukaano/validation'
import type { CreateCustomerInput, UpdateCustomerInput } from '@dukaano/validation'
import { BusinessRuleError, ConflictError, NotFoundError } from '../../common/errors/domain-error'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'
import { ChangeLogService } from '../sync/change-log.service'
import { LedgerService } from './ledger.service'

@Injectable()
export class CustomersService {
  constructor(
    private readonly changeLog: ChangeLogService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Search by name or phone.
   *
   * Phone matching is done on the **normalized E.164** form, which is what makes "9876543210",
   * "+919876543210" and "098765 43210" one customer rather than three (§25 E-16). A shopkeeper
   * typing the last four digits — which is how they actually remember a regular — is matched too.
   */
  async search(shopId: string, term: string, limit = 20) {
    const trimmed = term.trim()
    if (trimmed === '') return this.recent(shopId, limit)

    const parsed = normalizeIndianPhone(trimmed)
    const phoneFragment = trimmed.replace(/\D/g, '')

    return tenantClient().$queryRaw<
      { id: string; name: string; phoneE164: string | null; outstandingPaise: bigint }[]
    >`
      SELECT c.id, c.name, c.phone_e164 AS "phoneE164",
             coalesce(b.outstanding_paise, 0) AS "outstandingPaise"
      FROM customer c
      LEFT JOIN customer_balance b ON b.shop_id = c.shop_id AND b.customer_id = c.id
      WHERE c.shop_id = ${shopId}::uuid
        AND c.archived_at IS NULL
        AND (
          c.name ILIKE ${`%${trimmed}%`}
          OR (${parsed.ok ? parsed.e164 : null}::text IS NOT NULL AND c.phone_e164 = ${parsed.ok ? parsed.e164 : null})
          OR (${phoneFragment.length >= 4}::boolean AND c.phone_e164 LIKE ${`%${phoneFragment}`})
        )
      ORDER BY coalesce(b.outstanding_paise, 0) DESC, c.name
      LIMIT ${limit}
    `
  }

  async recent(shopId: string, limit = 20) {
    return tenantClient().$queryRaw<
      { id: string; name: string; phoneE164: string | null; outstandingPaise: bigint }[]
    >`
      SELECT c.id, c.name, c.phone_e164 AS "phoneE164",
             coalesce(b.outstanding_paise, 0) AS "outstandingPaise"
      FROM customer c
      LEFT JOIN customer_balance b ON b.shop_id = c.shop_id AND b.customer_id = c.id
      WHERE c.shop_id = ${shopId}::uuid AND c.archived_at IS NULL
      ORDER BY b.last_activity_at DESC NULLS LAST, c.created_at DESC
      LIMIT ${limit}
    `
  }

  async findById(shopId: string, id: string) {
    const customer = await tenantClient().customer.findFirst({
      where: { id, shopId },
      include: { balance: { select: { outstandingPaise: true, lastActivityAt: true } } },
    })
    if (!customer) throw new NotFoundError('Customer', id)
    return customer
  }

  /**
   * Create a customer, optionally with an opening balance from a paper khata.
   *
   * The opening balance is written as an `OPENING_BALANCE` **ledger entry**, never as a bare
   * balance — the same rule as opening stock (§17.2). A shopkeeper migrating years of paper owes
   * their customer an explanation of where the number came from, and a balance with no entry
   * behind it cannot give one.
   */
  async create(shopId: string, input: CreateCustomerInput) {
    const phoneE164 = await this.assertPhoneIsFree(shopId, input.phone)

    const customerId = input.id ?? randomUUID()
    await tenantClient().customer.create({
      data: {
        id: customerId,
        shopId,
        name: input.name.trim(),
        phoneE164,
        address: input.address?.trim() || null,
        notes: input.notes?.trim() || null,
        creditLimitPaise: input.creditLimitPaise != null ? BigInt(input.creditLimitPaise) : null,
        clientUpdatedAt: input.clientUpdatedAt ?? null,
        createdByUserId: currentContext()?.userId ?? null,
      },
    })

    await this.changeLog.record({
      entity: 'customer',
      entityId: customerId,
      op: 'upsert',
      rowVersion: 1,
    })

    if (input.openingBalancePaise && input.openingBalancePaise !== 0) {
      await this.ledger.append({
        customerId,
        entryType: 'OPENING_BALANCE',
        magnitudePaise: input.openingBalancePaise,
        note: 'Carried forward from paper khata',
      })
    }

    return this.findById(shopId, customerId)
  }

  async update(shopId: string, id: string, input: UpdateCustomerInput) {
    await this.findById(shopId, id)
    const phoneE164 = input.phone !== undefined ? await this.assertPhoneIsFree(shopId, input.phone, id) : undefined

    await tenantClient().customer.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        phoneE164: input.phone !== undefined ? phoneE164 : undefined,
        address: input.address !== undefined ? input.address?.trim() || null : undefined,
        notes: input.notes !== undefined ? input.notes?.trim() || null : undefined,
        creditLimitPaise:
          input.creditLimitPaise !== undefined
            ? input.creditLimitPaise === null
              ? null
              : BigInt(input.creditLimitPaise)
            : undefined,
        clientUpdatedAt: input.clientUpdatedAt ?? undefined,
        rowVersion: { increment: 1n },
      },
    })

    await this.changeLog.record({ entity: 'customer', entityId: id, op: 'upsert', rowVersion: 1 })
    return this.findById(shopId, id)
  }

  /**
   * Archive a customer.
   *
   * **Blocked while they still owe money** (§25 E-8). This is one of the few hard blocks in
   * Dukaano, and it earns it: archiving someone with an outstanding balance silently removes that
   * money from every ageing report and total, so the shop's receivables quietly shrink with no
   * record of a decision. If the debt is genuinely uncollectable there is a `WRITE_OFF` entry for
   * exactly that, and it stays permanently visible.
   *
   * A customer in **credit** may be archived: the shop owes them, and nothing is being hidden
   * from the shop's own books.
   */
  async archive(shopId: string, id: string) {
    const customer = await tenantClient().customer.findFirst({
      where: { id, shopId, archivedAt: null },
      include: { balance: { select: { outstandingPaise: true } } },
    })
    if (!customer) throw new NotFoundError('Customer', id)

    const outstanding = Number(customer.balance?.outstandingPaise ?? 0n)
    if (outstanding > 0) {
      throw new BusinessRuleError(
        'CUSTOMER_HAS_OUTSTANDING',
        'errors.customer.hasOutstanding',
        { name: customer.name, amount: outstanding },
        'Settle or write off the balance before archiving',
      )
    }

    const archived = await tenantClient().customer.update({
      where: { id },
      data: { archivedAt: new Date(), isActive: false, rowVersion: { increment: 1n } },
      select: { id: true, archivedAt: true },
    })

    await this.changeLog.record({ entity: 'customer', entityId: id, op: 'archive', rowVersion: 1 })
    return archived
  }

  /**
   * The khata list: who owes what, worst first.
   *
   * Ageing is computed from each customer's **oldest unpaid bill**, not from their last activity.
   * A customer who bought again yesterday but has a three-month-old unpaid bill is a three-month
   * problem, and sorting by last activity would hide exactly the debts worth chasing.
   */
  async ageing(shopId: string) {
    const rows = await tenantClient().$queryRaw<
      {
        customerId: string
        name: string
        phoneE164: string | null
        outstandingPaise: bigint
        oldestUnpaidDate: Date | null
      }[]
    >`
      SELECT c.id AS "customerId", c.name, c.phone_e164 AS "phoneE164",
             b.outstanding_paise AS "outstandingPaise",
             (
               SELECT min(s.business_date)
               FROM sale s
               WHERE s.shop_id = c.shop_id
                 AND s.customer_id = c.id
                 AND s.status = 'COMPLETED'
                 AND s.credit_paise > 0
             ) AS "oldestUnpaidDate"
      FROM customer_balance b
      JOIN customer c ON c.shop_id = b.shop_id AND c.id = b.customer_id
      WHERE b.shop_id = ${shopId}::uuid
        AND b.outstanding_paise > 0
        AND c.archived_at IS NULL
      ORDER BY b.outstanding_paise DESC
      LIMIT 500
    `

    const today = Date.now()
    return rows.map((row) => {
      const ageInDays = row.oldestUnpaidDate
        ? Math.floor((today - row.oldestUnpaidDate.getTime()) / 86_400_000)
        : 0
      return { ...row, ageInDays, bucket: ageingBucket(ageInDays) }
    })
  }

  /**
   * One customer per phone number, matched on the normalized form.
   *
   * A customer with no phone is allowed and common — plenty of khata regulars are known by face
   * and name — so the uniqueness rule only applies when a number is given.
   */
  private async assertPhoneIsFree(
    shopId: string,
    phone: string | null | undefined,
    excludeId?: string,
  ): Promise<string | null> {
    if (!phone?.trim()) return null

    const parsed = normalizeIndianPhone(phone)
    if (!parsed.ok) {
      throw new BusinessRuleError('INVALID_PHONE', parsed.errorKey, {}, `Invalid phone: ${phone}`)
    }

    const clash = await tenantClient().customer.findFirst({
      where: {
        shopId,
        phoneE164: parsed.e164,
        archivedAt: null,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true, name: true },
    })
    if (clash) {
      throw new ConflictError('DUPLICATE_CUSTOMER', 'errors.customer.duplicatePhone', {
        name: clash.name,
      })
    }

    return parsed.e164
  }
}
