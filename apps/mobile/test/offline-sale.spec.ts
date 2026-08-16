import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acknowledge, blockedEntityIds, enqueue, fail, pending, pendingCount, stuck } from '../src/data/outbox'
import {
  OfflineSaleError,
  drawInvoiceNumber,
  recordSale,
  remainingLeaseNumbers,
  todayTotals,
} from '../src/data/sales.repository'
import { migrate } from '../src/data/schema'
import type { SqliteDatabase } from '../src/data/sqlite'
import { createTestDatabase, seedLease, seedProduct, sequentialIds } from './node-sqlite'

/**
 * The offline engine, against real SQLite.
 *
 * These run in Node through `node:sqlite` — the same engine the phone uses, reached through a
 * different binding — so the SQL, the CHECK constraints and the transaction semantics under test
 * are the ones that will actually run at a counter with no signal.
 */
describe('offline sale', () => {
  let db: SqliteDatabase & { close(): void }

  beforeEach(() => {
    db = createTestDatabase()
    seedLease(db)
    seedProduct(db, { id: 'sugar', nameEn: 'Sugar Loose', nameHi: 'चीनी', qtyMilli: 50_000 })
    seedProduct(db, { id: 'rice', nameEn: 'Rice', unitCode: 'KG', qtyMilli: 30_000 })
  })

  afterEach(() => {
    db.close()
  })

  const sale = (overrides: Partial<Parameters<typeof recordSale>[1]> = {}) =>
    recordSale(db, {
      saleId: 'sale-1',
      opId: 'op-1',
      lines: [{ productId: 'sugar', qtyMilli: 1_500, unitPricePaise: 4_450 }],
      payments: [{ method: 'CASH', amountPaise: 6_675 }],
      newId: sequentialIds('row'),
      ...overrides,
    })

  describe('the write path', () => {
    it('records the bill using the same money package as the server', () => {
      // 1.5 kg × ₹44.50 = ₹66.75, rounded once at the line.
      const result = sale()

      expect(result.totalPaise).toBe(6_675)
      expect(result.paidPaise).toBe(6_675)
      expect(result.creditPaise).toBe(0)
      expect(result.saleNumber).toBe('INV-0001')
    })

    it('writes the sale, its items, its payment and its outbox row', () => {
      sale()

      expect(db.all('SELECT * FROM sale')).toHaveLength(1)
      expect(db.all('SELECT * FROM sale_item')).toHaveLength(1)
      expect(db.all('SELECT * FROM payment')).toHaveLength(1)
      expect(pendingCount(db)).toBe(1)
    })

    it('snapshots the product name and unit onto the line', () => {
      sale()
      const [item] = db.all<{ product_name_snapshot: string; unit_snapshot: string }>(
        'SELECT product_name_snapshot, unit_snapshot FROM sale_item',
      )
      // So a renamed or archived product still renders this bill correctly (§25 E-9).
      expect(item?.product_name_snapshot).toBe('Sugar Loose')
      expect(item?.unit_snapshot).toBe('KG')
    })

    it('decrements local stock immediately rather than waiting for the server', () => {
      sale()
      const [balance] = db.all<{ qty_milli: number }>(
        "SELECT qty_milli FROM inventory_balance WHERE product_id = 'sugar'",
      )
      // The shopkeeper is looking at the shelf now. A number that does not move until the phone
      // reconnects is worse than one that is briefly optimistic.
      expect(balance?.qty_milli).toBe(48_500)
    })

    it('allows stock to go negative and reports which products did (§14.8)', () => {
      const result = sale({
        lines: [{ productId: 'rice', qtyMilli: 40_000, unitPricePaise: 6_000 }],
        payments: [{ method: 'CASH', amountPaise: 240_000 }],
      })

      // The goods left the shop and the money entered the till. Refusing would destroy the
      // financial record to protect a count.
      expect(result.wentNegative).toEqual(['rice'])
      const [balance] = db.all<{ qty_milli: number }>(
        "SELECT qty_milli FROM inventory_balance WHERE product_id = 'rice'",
      )
      expect(balance?.qty_milli).toBe(-10_000)
    })

    it('puts the credit portion on the customer, with no payment row for it (§19.1)', () => {
      const result = sale({
        customerId: 'ramesh',
        payments: [{ method: 'CASH', amountPaise: 4_000 }],
      })

      expect(result.creditPaise).toBe(2_675)
      // One payment row for the ₹40 actually handed over — and nothing for the udhaar.
      expect(db.all('SELECT * FROM payment')).toHaveLength(1)

      const [balance] = db.all<{ outstanding_paise: number }>(
        "SELECT outstanding_paise FROM customer_balance WHERE customer_id = 'ramesh'",
      )
      expect(balance?.outstanding_paise).toBe(2_675)
    })

    it('computes the business date on the device, in the shop timezone (§25 E-20)', () => {
      // 00:30 IST in a shop whose day starts at 04:00 belongs to the previous day's takings.
      const result = sale({
        occurredAt: new Date('2026-08-16T19:00:00.000Z'), // 00:30 IST on the 17th
        timezone: 'Asia/Kolkata',
        businessDayStartHour: 4,
      })
      expect(result.businessDate).toBe('2026-08-16')
    })
  })

  describe('the identity the device refuses to break', () => {
    it('rejects an overpayment rather than recording change as revenue', () => {
      expect(() => sale({ payments: [{ method: 'CASH', amountPaise: 10_000 }] })).toThrow(
        OfflineSaleError,
      )
    })

    it('refuses credit with nobody to owe it', () => {
      expect(() => sale({ payments: [{ method: 'CASH', amountPaise: 1_000 }] })).toThrow(
        /customer/i,
      )
    })

    it('refuses an empty cart', () => {
      expect(() => sale({ lines: [] })).toThrow(OfflineSaleError)
    })

    it('the CHECK constraint holds even if the service were bypassed', () => {
      // The schema is the backstop, not the service. A bill that does not reconcile must never
      // leave the device — the server would reject it and the goods are already gone.
      expect(() =>
        db.run(
          `INSERT INTO sale (id, sale_number, status, subtotal_paise, total_paise, paid_paise,
             credit_paise, business_date, occurred_at)
           VALUES ('bad', 'X-1', 'COMPLETED', 100, 100, 40, 40, '2026-08-16', 0)`,
        ),
      ).toThrow()
    })

    it('the schema refuses UDHAAR as a payment method', () => {
      expect(() =>
        db.run(
          `INSERT INTO payment (id, method, amount_paise, occurred_at)
           VALUES ('p', 'UDHAAR', 100, 0)`,
        ),
      ).toThrow()
    })
  })

  describe('atomicity — the property the whole design rests on', () => {
    it('leaves nothing behind when a line fails part-way through', () => {
      /*
       * The failure this guards is silent and permanent: a sale on the phone that was never
       * queued reaches nobody, reports nothing, and is discovered at month end if ever.
       */
      expect(() =>
        sale({
          lines: [
            { productId: 'sugar', qtyMilli: 1_000, unitPricePaise: 4_450 },
            { productId: 'does-not-exist', qtyMilli: 1_000, unitPricePaise: 100 },
          ],
          payments: [{ method: 'CASH', amountPaise: 4_550 }],
        }),
      ).toThrow(OfflineSaleError)

      expect(db.all('SELECT * FROM sale')).toHaveLength(0)
      expect(db.all('SELECT * FROM sale_item')).toHaveLength(0)
      expect(db.all('SELECT * FROM payment')).toHaveLength(0)
      expect(pendingCount(db)).toBe(0)

      // And the stock never moved.
      const [balance] = db.all<{ qty_milli: number }>(
        "SELECT qty_milli FROM inventory_balance WHERE product_id = 'sugar'",
      )
      expect(balance?.qty_milli).toBe(50_000)
    })

    it('does not consume an invoice number on a failed sale', () => {
      const before = remainingLeaseNumbers(db)
      expect(() => sale({ lines: [{ productId: 'ghost', qtyMilli: 1, unitPricePaise: 1 }] })).toThrow()
      // A burnt number is a permanent gap for a bill that never existed.
      expect(remainingLeaseNumbers(db)).toBe(before)
    })

    it('never has a sale without its outbox row', () => {
      for (let i = 0; i < 5; i++) {
        recordSale(db, {
          saleId: `s-${i}`,
          opId: `o-${i}`,
          lines: [{ productId: 'sugar', qtyMilli: 1_000, unitPricePaise: 4_450 }],
          payments: [{ method: 'CASH', amountPaise: 4_450 }],
          newId: sequentialIds(`r${i}`),
        })
      }

      const sales = db.all<{ id: string }>('SELECT id FROM sale')
      const queued = new Set(pending(db, 100).map((op) => op.entityId))
      for (const s of sales) expect(queued.has(s.id)).toBe(true)
    })
  })

  describe('invoice number leases (§14.6)', () => {
    it('draws sequentially and reports what is left', () => {
      expect(drawInvoiceNumber(db)).toBe('INV-0001')
      expect(drawInvoiceNumber(db)).toBe('INV-0002')
      expect(remainingLeaseNumbers(db)).toBe(198)
    })

    it('refuses to invent a number when the lease is exhausted', () => {
      db.run("UPDATE number_lease SET next_value = range_to + 1 WHERE series = 'INV'")
      // Inventing one would collide with another device's block, and two customers would hold
      // receipts bearing the same invoice number — worse than any gap.
      expect(() => drawInvoiceNumber(db)).toThrow(/no invoice numbers/i)
    })

    it('reports zero remaining when the device has never been given a lease', () => {
      db.run("DELETE FROM number_lease WHERE series = 'INV'")
      expect(remainingLeaseNumbers(db)).toBe(0)
      expect(() => drawInvoiceNumber(db)).toThrow(OfflineSaleError)
    })
  })

  describe("today's totals, computed on-device", () => {
    it('sums the day without a network', () => {
      sale({ saleId: 'a', opId: 'oa', occurredAt: new Date('2026-08-16T06:00:00.000Z') })
      recordSale(db, {
        saleId: 'b',
        opId: 'ob',
        customerId: 'ramesh',
        lines: [{ productId: 'rice', qtyMilli: 1_000, unitPricePaise: 6_000 }],
        payments: [],
        occurredAt: new Date('2026-08-16T07:00:00.000Z'),
        newId: sequentialIds('rb'),
      })

      const totals = todayTotals(db, '2026-08-16')
      expect(totals.saleCount).toBe(2)
      expect(totals.totalPaise).toBe(6_675 + 6_000)
      expect(totals.creditPaise).toBe(6_000)
      // Cash counts only what was actually handed over.
      expect(totals.cashPaise).toBe(6_675)
    })

    it('returns zeros for a day with no trading rather than nulls', () => {
      expect(todayTotals(db, '2020-01-01')).toEqual({
        saleCount: 0,
        totalPaise: 0,
        creditPaise: 0,
        cashPaise: 0,
      })
    })
  })
})

describe('outbox', () => {
  let db: SqliteDatabase & { close(): void }

  beforeEach(() => {
    db = createTestDatabase()
  })
  afterEach(() => db.close())

  const queue = (opId: string, entityId = 'e1', entity = 'sale') =>
    enqueue(db, { opId, entity, entityId, opType: 'create', payload: { n: 1 }, now: 1_000 })

  it('assigns strictly increasing sequence numbers', () => {
    expect(queue('a').seq).toBe(1)
    expect(queue('b').seq).toBe(2)
    expect(queue('c').seq).toBe(3)
  })

  it('keeps increasing after the queue drains', () => {
    /*
     * The bug this guards: with `max(seq) + 1`, an emptied outbox restarts at 1, and the next op
     * sorts AHEAD of anything queued before it — flushing a payment before the sale it belongs to,
     * which the server rejects as a missing reference.
     */
    queue('a')
    queue('b')
    acknowledge(db, 'a')
    acknowledge(db, 'b')
    expect(queue('c').seq).toBe(3)
  })

  it('flushes in seq order', () => {
    queue('a')
    queue('b')
    queue('c')
    expect(pending(db).map((op) => op.opId)).toEqual(['a', 'b', 'c'])
  })

  it('round-trips the payload as JSON', () => {
    enqueue(db, {
      opId: 'x',
      entity: 'sale',
      entityId: 'e',
      opType: 'create',
      payload: { items: [{ qtyMilli: 1_500 }], nested: { hi: 'चीनी' } },
    })
    expect(pending(db)[0]?.payload).toEqual({ items: [{ qtyMilli: 1_500 }], nested: { hi: 'चीनी' } })
  })

  it('removes an acknowledged op', () => {
    queue('a')
    acknowledge(db, 'a')
    expect(pendingCount(db)).toBe(0)
  })

  it('backs off a retryable failure without losing the op', () => {
    queue('a')
    fail(db, 'a', 'network down', { now: 1_000, jitter: 0 })

    // Still queued — a failure is not a reason to discard a sale that happened.
    expect(pendingCount(db)).toBe(1)
    // And not offered again until its delay elapses.
    expect(pending(db, 100, 1_500)).toHaveLength(0)
    expect(pending(db, 100, 2_500)).toHaveLength(1)
  })

  it('lengthens the delay with each attempt, following the shared schedule', () => {
    queue('a')
    const delays: number[] = []
    for (let attempt = 0; attempt < 4; attempt++) {
      fail(db, 'a', 'still down', { now: 0, jitter: 0 })
      const [row] = db.all<{ next_retry_at: number }>(
        "SELECT next_retry_at FROM sync_outbox WHERE op_id = 'a'",
      )
      delays.push(row?.next_retry_at ?? 0)
    }
    // 1s → 2s → 5s → 15s, from @dukaano/business-logic — the same schedule the server was
    // designed against.
    expect(delays).toEqual([1_000, 2_000, 5_000, 15_000])
  })

  it('drops a permanently rejected op rather than retrying it forever', () => {
    queue('a')
    // The caller records it in the conflict inbox first; keeping a doomed row would mean the
    // queue never drains and the sync pill never clears.
    fail(db, 'a', 'PERMISSION_REVOKED', { permanent: true })
    expect(pendingCount(db)).toBe(0)
  })

  it('ignores a failure for an op that is already gone', () => {
    expect(() => fail(db, 'never-existed', 'boom')).not.toThrow()
  })

  it('surfaces ops that have failed enough times to tell the shopkeeper about', () => {
    queue('a')
    for (let i = 0; i < 5; i++) fail(db, 'a', 'down', { now: 0, jitter: 0 })
    // The sync banner is persistent and never lies (§14.9).
    expect(stuck(db).map((op) => op.opId)).toEqual(['a'])
  })

  it('does not let one failing op block unrelated work', () => {
    queue('a', 'sale-1')
    queue('b', 'sale-2')
    fail(db, 'a', 'down', { now: 0, jitter: 0 })

    // 'b' is a different entity chain and must keep moving — otherwise one poisonous op stops a
    // fortnight of good work from ever syncing.
    expect(pending(db, 100, 100).map((op) => op.opId)).toEqual(['b'])
  })

  it('reports which entity chains are blocked, so dependants wait', () => {
    queue('a', 'sale-1')
    fail(db, 'a', 'down', { now: 0, jitter: 0 })

    // A payment referencing sale-1 must not be sent while sale-1's own op is failing, or the
    // server sees a payment for a sale it has never heard of.
    expect(blockedEntityIds(db, 100).has('sale-1')).toBe(true)
    expect(blockedEntityIds(db, 100).has('sale-2')).toBe(false)
  })
})

describe('schema migration', () => {
  it('is idempotent across repeated launches', () => {
    const db = createTestDatabase()
    // createTestDatabase already migrated once; migrating again must be a no-op rather than
    // throwing on a table that already exists. This is what every app launch after the first does.
    expect(() => migrate(db)).not.toThrow()
    expect(migrate(db)).toBe(1)
    db.close()
  })

  it('enables foreign keys, which SQLite leaves off by default', () => {
    const db = createTestDatabase()
    seedLease(db)
    seedProduct(db, { id: 'p' })
    recordSale(db, {
      saleId: 's',
      opId: 'o',
      lines: [{ productId: 'p', qtyMilli: 1_000, unitPricePaise: 100 }],
      payments: [{ method: 'CASH', amountPaise: 100 }],
      newId: sequentialIds(),
    })

    db.run("DELETE FROM sale WHERE id = 's'")
    // Without `PRAGMA foreign_keys = ON` — off by default on every connection — the cascade
    // silently would not happen and orphaned lines would accumulate forever.
    expect(db.all('SELECT * FROM sale_item')).toHaveLength(0)
    db.close()
  })
})
