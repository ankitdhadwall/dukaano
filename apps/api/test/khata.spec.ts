import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { execSync } from 'node:child_process'
import type { INestApplication } from '@nestjs/common'
import { createTestApp, nextPhone, prepareTestDatabase, truncateAll } from './harness'

/**
 * Phase 5 — Customers & Khata (blueprint §18, §28).
 *
 * The services were built alongside billing in Phase 4. This file exists to prove the phase's own
 * acceptance criteria explicitly rather than leaving them implied by the billing suite:
 *
 *   • the ledger property test is green
 *   • concurrent payments are correct
 *   • the §18.3 worked example is reproduced **exactly**
 *   • archive-with-balance is blocked
 */
describe('customers and khata', () => {
  let app: INestApplication
  let token = ''
  let shopId = ''
  let sugarId = ''

  const auth = () => ({ Authorization: `Bearer ${token}` })
  const server = () => app.getHttpServer()

  const sql = (statement: string) =>
    execSync(
      `docker exec dukaano-postgres psql -U dukaano -d dukaano_test -qtAc ${JSON.stringify(statement)}`,
      { stdio: 'pipe', shell: '/bin/bash' },
    )
      .toString()
      .trim()

  const num = (statement: string) => Number(sql(statement) || '0')

  beforeAll(async () => {
    prepareTestDatabase()
    truncateAll()
    app = await createTestApp()

    const owner = await request(server())
      .post('/v1/auth/register')
      .send({
        phone: nextPhone(),
        password: 'correct horse battery',
        fullName: 'Ankit Dhadwal',
        shopName: 'Dhadwal Confectionery & General Store',
      })
      .expect(201)
    token = owner.body.data.accessToken
    shopId = owner.body.data.shop.id

    const sugar = await request(server())
      .post('/v1/products')
      .set(auth())
      .send({
        nameEn: 'Sugar Loose', unitCode: 'KG',
        sellingPricePaise: 4_600, purchasePricePaise: 4_000, openingStockMilli: 500_000,
      })
      .expect(201)
    sugarId = sugar.body.data.id
  }, 120_000)

  afterAll(async () => {
    await app?.close()
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // The §18.3 worked example, reproduced exactly
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('the §18.3 worked example, reproduced exactly', () => {
    let rameshId = ''

    it('produces the three rows and the ₹1,000 closing balance', async () => {
      /*
       * Ramesh Sharma — Khata
       * ──────────────────────────────────────────────────────────────────────
       * 2026-08-10  Opening / carried fwd                            ₹840
       * 2026-08-16  Purchase (credit)         INV-0113   +₹460     ₹1,300
       * 2026-08-16  Payment received (Cash)   PAY-0087   −₹300     ₹1,000
       * ──────────────────────────────────────────────────────────────────────
       * Outstanding                                                ₹1,000
       *
       * Three immutable rows. The balance was never assigned — it was derived and stamped.
       */
      const ramesh = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Ramesh Sharma', phone: '9816011113', openingBalancePaise: 84_000 })
        .expect(201)
      rameshId = ramesh.body.data.id

      // INV-0113: a ₹460 purchase entirely on credit.
      await request(server())
        .post('/v1/sales')
        .set(auth())
        .send({
          customerId: rameshId,
          saleNumber: 'INV-0113',
          items: [{ productId: sugarId, qtyMilli: 10_000, unitPricePaise: 4_600 }],
          payments: [],
        })
        .expect(201)

      // PAY-0087: ₹300 received in cash.
      await request(server())
        .post('/v1/payments')
        .set(auth())
        .send({ customerId: rameshId, method: 'CASH', amountPaise: 30_000 })
        .expect(201)

      const statement = await request(server())
        .get(`/v1/customers/${rameshId}/statement`)
        .set(auth())
        .expect(200)

      const rows = statement.body.data.entries.map(
        (e: { entryType: string; amountPaise: number; balanceAfterPaise: number }) => [
          e.entryType,
          e.amountPaise,
          e.balanceAfterPaise,
        ],
      )

      expect(rows).toEqual([
        ['OPENING_BALANCE', 84_000, 84_000],
        ['SALE_CREDIT', 46_000, 130_000],
        ['PAYMENT_RECEIVED', -30_000, 100_000],
      ])
      expect(statement.body.data.outstandingPaise).toBe(100_000)
    })

    it('cancelling INV-0113 appends a fourth row rather than editing the second', async () => {
      // §18.3, verbatim: "Cancelling INV-0113 tomorrow appends a fourth row
      // (SALE_CANCELLED −₹460 → ₹540); it does not edit row two."
      const saleId = sql(`SELECT id FROM sale WHERE shop_id = '${shopId}' AND sale_number = 'INV-0113'`)

      await request(server())
        .post(`/v1/sales/${saleId}/cancel`)
        .set(auth())
        .send({ reason: 'Goods returned the next morning' })
        .expect(201)

      const statement = await request(server())
        .get(`/v1/customers/${rameshId}/statement`)
        .set(auth())
        .expect(200)

      const rows = statement.body.data.entries.map(
        (e: { entryType: string; amountPaise: number; balanceAfterPaise: number }) => [
          e.entryType,
          e.amountPaise,
          e.balanceAfterPaise,
        ],
      )

      expect(rows).toEqual([
        ['OPENING_BALANCE', 84_000, 84_000],
        ['SALE_CREDIT', 46_000, 130_000],
        ['PAYMENT_RECEIVED', -30_000, 100_000],
        ['SALE_CANCELLED', -46_000, 54_000],
      ])
      expect(statement.body.data.outstandingPaise).toBe(54_000)

      // Row two is untouched — byte for byte the entry that was written before the cancellation.
      expect(rows[1]).toEqual(['SALE_CREDIT', 46_000, 130_000])
    })

    it('has never issued an UPDATE against the append-only tables', () => {
      /*
       * §18.1 rule 1 and §17.2: the ledger and the inventory log are append-only. A correction is
       * a new row, never an edit — which is what lets a shopkeeper show the ledger to a customer
       * as an explanation rather than a claim.
       *
       * Postgres counts row operations per table in `pg_stat_user_tables`, cumulatively for the
       * life of the database and unaffected by TRUNCATE. So this is not a statement about this
       * suite; it is a statement about **every test that has ever run** against dukaano_test.
       */
      const upd = (table: string) =>
        num(`SELECT coalesce(n_tup_upd, 0) FROM pg_stat_user_tables WHERE relname = '${table}'`)
      const ins = (table: string) =>
        num(`SELECT coalesce(n_tup_ins, 0) FROM pg_stat_user_tables WHERE relname = '${table}'`)

      // Guard against a vacuous pass. If the stats collector were not recording, or these tables
      // were empty, zero updates would prove nothing — so require real inserts here and real
      // updates on a comparable mutable table before believing the zeros below.
      expect(ins('customer_ledger_entry'), 'no ledger entries written — the check is vacuous').toBeGreaterThan(0)
      expect(ins('inventory_transaction'), 'no stock movements written — the check is vacuous').toBeGreaterThan(0)
      expect(
        upd('customer_balance'),
        'the update counter is not recording, so zero updates below would prove nothing',
      ).toBeGreaterThan(0)

      expect(upd('customer_ledger_entry'), 'a ledger entry was updated').toBe(0)
      expect(upd('inventory_transaction'), 'a stock movement was updated').toBe(0)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // The ledger property test
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('ledger property test', () => {
    it('balance == Σ entries after a long random sequence of khata activity', async () => {
      /*
       * The property, over a randomly generated but reproducible sequence: whatever order sales,
       * payments, cancellations and corrections arrive in, the stored balance always equals the
       * sum of the entries, and every `balance_after_paise` reproduces the running total when the
       * entries are replayed in insertion order.
       *
       * Seeded deterministically so a failure is reproducible — a property test that cannot be
       * re-run with the same inputs is a flake generator, not a test.
       */
      let seed = 20260816
      const rand = (max: number) => {
        // Mulberry32 — small, fast, and identical on every run.
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return Math.abs((t ^ (t >>> 14)) >>> 0) % max
      }

      const customer = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Property Test', openingBalancePaise: rand(200_000) })
        .expect(201)
      const customerId = customer.body.data.id

      const saleIds: string[] = []

      for (let i = 0; i < 40; i++) {
        const action = rand(10)

        if (action < 4) {
          // A credit sale.
          const sale = await request(server())
            .post('/v1/sales')
            .set(auth())
            .send({
              customerId,
              items: [{ productId: sugarId, qtyMilli: 1_000 + rand(5_000), unitPricePaise: 4_600 }],
              payments: [],
            })
            .expect(201)
          saleIds.push(sale.body.data.id)
        } else if (action < 7) {
          // A khata collection.
          await request(server())
            .post('/v1/payments')
            .set(auth())
            .send({ customerId, method: 'CASH', amountPaise: 1_000 + rand(30_000) })
            .expect(201)
        } else if (action < 9 && saleIds.length > 0) {
          // Cancel an earlier credit sale.
          const target = saleIds.splice(rand(saleIds.length), 1)[0]!
          await request(server())
            .post(`/v1/sales/${target}/cancel`)
            .set(auth())
            .send({ reason: 'Property test cancellation' })
            .expect(201)
        } else {
          // An owner correction.
          await request(server())
            .post('/v1/khata/adjustments')
            .set(auth())
            .send({
              customerId,
              entryType: rand(2) === 0 ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT',
              magnitudePaise: 100 + rand(5_000),
              reason: 'Property test correction',
            })
            .expect(201)
        }
      }

      // Property 1 — the snapshot equals the sum of the log.
      const stored = num(
        `SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${customerId}'`,
      )
      const summed = num(
        `SELECT coalesce(sum(amount_paise), 0) FROM customer_ledger_entry WHERE customer_id = '${customerId}'`,
      )
      expect(stored).toBe(summed)

      // Property 2 — replaying the entries in insertion order reproduces every stamped
      // `balance_after_paise`. This is what makes a statement coherent to read.
      const replayMismatches = num(`
        SELECT count(*) FROM (
          SELECT balance_after_paise,
                 sum(amount_paise) OVER (ORDER BY created_at, id) AS running
          FROM customer_ledger_entry
          WHERE customer_id = '${customerId}'
        ) t WHERE t.balance_after_paise <> t.running
      `.replace(/\s+/g, ' '))
      expect(replayMismatches, 'a stamped balance did not match the replayed running total').toBe(0)
    }, 180_000)

    it('reconciles across every customer in the shop', async () => {
      const response = await request(server()).get('/v1/khata/reconcile').set(auth()).expect(200)
      expect(response.body.data.mismatchCount).toBe(0)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Concurrency
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('concurrent payments are correct (§25 E-27)', () => {
    it('applies twenty simultaneous collections to one customer without losing any', async () => {
      const customer = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Concurrency Test', openingBalancePaise: 500_000 })
        .expect(201)
      const customerId = customer.body.data.id

      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          request(server())
            .post('/v1/payments')
            .set(auth())
            .send({ customerId, method: 'CASH', amountPaise: 10_000 }),
        ),
      )
      expect(responses.every((r) => r.status === 201)).toBe(true)

      // Without the FOR UPDATE lock in LedgerService, some of these would read the same starting
      // balance and silently overwrite each other — the customer's money received and then erased.
      expect(
        num(`SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${customerId}'`),
      ).toBe(500_000 - 20 * 10_000)

      // 1 opening + 20 payments, and the running balance still replays cleanly.
      expect(
        num(`SELECT count(*) FROM customer_ledger_entry WHERE customer_id = '${customerId}'`),
      ).toBe(21)

      const replayMismatches = num(`
        SELECT count(*) FROM (
          SELECT balance_after_paise,
                 sum(amount_paise) OVER (ORDER BY created_at, id) AS running
          FROM customer_ledger_entry WHERE customer_id = '${customerId}'
        ) t WHERE t.balance_after_paise <> t.running
      `.replace(/\s+/g, ' '))
      expect(replayMismatches).toBe(0)
    }, 120_000)
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Customer identity and archiving
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('phone normalization and duplicate detection (§25 E-16)', () => {
    it.each([
      ['9816022221', '+919816022221'],
      ['+91 98160 22222', '+919816022222'],
      ['098160 22223', '+919816022223'],
      ['91-9816022224', '+919816022224'],
    ])('stores %s as %s', async (written, expected) => {
      const response = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: `Customer ${written}`, phone: written })
        .expect(201)
      expect(response.body.data.phoneE164).toBe(expected)
    })

    it('treats three written forms of one number as the same customer', async () => {
      await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Original', phone: '9816033330' })
        .expect(201)

      // Same human, three spellings. Each must be refused as a duplicate.
      for (const spelling of ['+919816033330', '098160 33330', '91 9816033330']) {
        const response = await request(server())
          .post('/v1/customers')
          .set(auth())
          .send({ name: 'Duplicate attempt', phone: spelling })
          .expect(409)
        expect(response.body.error.code).toBe('DUPLICATE_CUSTOMER')
      }
    })

    it('allows a customer with no phone at all', async () => {
      // A khata regular is often known by face and first name. Demanding a number before the
      // shopkeeper can record what someone owes pushes them back to the paper notebook.
      const response = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Known by face only' })
        .expect(201)
      expect(response.body.data.phoneE164).toBeNull()
    })

    it('rejects a landline, which can never receive a reminder', async () => {
      await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Landline', phone: '01772345678' })
        .expect(422)
    })

    it('finds a customer by the last four digits, which is how they are remembered', async () => {
      const response = await request(server())
        .get('/v1/customers?q=3330')
        .set(auth())
        .expect(200)
      expect(response.body.data.some((c: { name: string }) => c.name === 'Original')).toBe(true)
    })
  })

  describe('archive-with-balance is blocked (§25 E-8)', () => {
    it('refuses to archive a customer who still owes money', async () => {
      const debtor = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Owes Money', openingBalancePaise: 50_000 })
        .expect(201)

      const response = await request(server())
        .delete(`/v1/customers/${debtor.body.data.id}`)
        .set(auth())
        .expect(422)

      // Archiving would silently remove the debt from every ageing report and total — the shop's
      // receivables shrinking with no record of a decision.
      expect(response.body.error.code).toBe('CUSTOMER_HAS_OUTSTANDING')
    })

    it('allows archiving once the balance is written off, and the write-off stays visible', async () => {
      const debtor = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Bad Debt', openingBalancePaise: 50_000 })
        .expect(201)
      const debtorId = debtor.body.data.id

      await request(server())
        .post('/v1/khata/adjustments')
        .set(auth())
        .send({
          customerId: debtorId,
          entryType: 'WRITE_OFF',
          magnitudePaise: 50_000,
          reason: 'Left town; uncollectable',
        })
        .expect(201)

      await request(server()).delete(`/v1/customers/${debtorId}`).set(auth()).expect(200)

      // The write-off is permanently in the ledger — that is the point of preferring it to a
      // quiet archive.
      const statement = await request(server())
        .get(`/v1/customers/${debtorId}/statement`)
        .set(auth())
        .expect(200)
      expect(
        statement.body.data.entries.some((e: { entryType: string }) => e.entryType === 'WRITE_OFF'),
      ).toBe(true)
      expect(statement.body.data.outstandingPaise).toBe(0)
    })

    it('allows archiving a customer holding an advance', async () => {
      // The shop owes them, not the other way round. Nothing is being hidden from the shop's books.
      const advance = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Paid Ahead' })
        .expect(201)

      await request(server())
        .post('/v1/payments')
        .set(auth())
        .send({ customerId: advance.body.data.id, method: 'CASH', amountPaise: 20_000 })
        .expect(201)

      await request(server()).delete(`/v1/customers/${advance.body.data.id}`).set(auth()).expect(200)
    })
  })
})
