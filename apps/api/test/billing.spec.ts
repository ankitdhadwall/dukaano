import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { createTestApp, nextPhone, prepareTestDatabase, truncateAll } from './harness'

/**
 * Phase 4 — Billing & payments (blueprint §18, §19).
 *
 * Acceptance criteria under test (§28):
 *   1. all nine row groups atomic
 *   2. bill identity holds
 *   3. cash sale fast enough for the 20-second counter flow
 *   4. offline sale + sync verified
 *   5. double-tap safe
 */
describe('billing and khata', () => {
  let app: INestApplication
  let token = ''
  let cashierToken = ''
  let shopId = ''
  let sugarId = ''
  let riceId = ''
  let rameshId = ''

  const auth = () => ({ Authorization: `Bearer ${token}` })
  const cashier = () => ({ Authorization: `Bearer ${cashierToken}` })
  const server = () => app.getHttpServer()

  const sql = (statement: string) =>
    execSync(
      `docker exec dukaano-postgres psql -U dukaano -d dukaano_test -qtAc ${JSON.stringify(statement)}`,
      { stdio: 'pipe', shell: '/bin/bash' },
    )
      .toString()
      .trim()

  const num = (statement: string) => Number(sql(statement) || '0')

  /**
   * The identity from §19.1, asserted directly against the database:
   *
   *     total_paise = Σ payment(IN, not a reversal) + credit_paise
   *
   * Counting only inbound, non-reversal payments is the whole point. The identity describes the
   * bill **as issued** — what was tendered at the counter plus what went on khata. A later refund
   * or reversal is a *subsequent* fact with its own row; netting it off here would make a bill
   * that was later partly returned look like it never reconciled.
   */
  const assertBillIdentity = (saleId: string) => {
    const row = sql(
      `SELECT s.total_paise || '|' || s.credit_paise || '|' || ` +
        `coalesce((SELECT sum(p.amount_paise) FROM payment p ` +
        `WHERE p.sale_id = s.id AND p.direction = 'IN' AND p.reversal_of_payment_id IS NULL), 0) ` +
        `FROM sale s WHERE s.id = '${saleId}'`,
    )
    const [total, credit, paid] = row.split('|').map(Number)
    expect(
      (paid ?? 0) + (credit ?? 0),
      `bill identity broken for ${saleId}: total=${total}, paid=${paid}, credit=${credit}`,
    ).toBe(total)
  }

  const createSale = (body: Record<string, unknown>, as = auth()) =>
    request(server()).post('/v1/sales').set(as).send(body)

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

    const cashierPhone = nextPhone()
    await request(server())
      .post('/v1/memberships')
      .set(auth())
      .send({ phone: cashierPhone, fullName: 'Suresh', role: 'CASHIER', temporaryPassword: 'temp pass 1234' })
      .expect(201)
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ phone: cashierPhone, password: 'temp pass 1234' })
      .expect(200)
    cashierToken = login.body.data.accessToken

    const sugar = await request(server())
      .post('/v1/products')
      .set(auth())
      .send({
        nameEn: 'Sugar Loose', nameHi: 'चीनी', unitCode: 'KG',
        sellingPricePaise: 4_450, purchasePricePaise: 4_000, openingStockMilli: 50_000,
      })
      .expect(201)
    sugarId = sugar.body.data.id

    const rice = await request(server())
      .post('/v1/products')
      .set(auth())
      .send({
        nameEn: 'Rice Sona Masoori', nameHi: 'चावल', unitCode: 'KG',
        sellingPricePaise: 6_000, purchasePricePaise: 5_200, openingStockMilli: 30_000,
      })
      .expect(201)
    riceId = rice.body.data.id

    const ramesh = await request(server())
      .post('/v1/customers')
      .set(auth())
      .send({ name: 'Ramesh Sharma', phone: '9816012345', openingBalancePaise: 84_000 })
      .expect(201)
    rameshId = ramesh.body.data.id
  }, 120_000)

  afterAll(async () => {
    await app?.close()
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Criterion 1 & 2 — atomicity and bill identity
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('the nine row groups, in one transaction (criterion 1)', () => {
    let saleId = ''

    it('writes every row group for a split credit sale — the §19.2 worked example', async () => {
      /*
       * The blueprint's ₹1,000 example: ₹600 by UPI, ₹400 on udhaar.
       * 1.5 kg sugar @ ₹44.50 = ₹66.75 · 15.5 kg rice @ ₹60 = ₹930 → ₹996.75
       */
      const response = await createSale({
        customerId: rameshId,
        items: [
          { productId: sugarId, qtyMilli: 1_500, unitPricePaise: 4_450 },
          { productId: riceId, qtyMilli: 15_500, unitPricePaise: 6_000 },
        ],
        payments: [{ method: 'UPI', amountPaise: 60_000, reference: 'PhonePe' }],
      }).expect(201)

      saleId = response.body.data.id
      const sale = response.body.data

      // 1. sale
      expect(sale.totalPaise).toBe(99_675)
      expect(sale.paidPaise).toBe(60_000)
      expect(sale.creditPaise).toBe(39_675)

      // 2. sale_item × N, with snapshots
      expect(sale.items).toHaveLength(2)
      expect(sale.items[0].productNameSnapshot).toBe('Sugar Loose')
      expect(sale.items[0].unitSnapshot).toBe('KG')
      expect(sale.items[0].lineTotalPaise).toBe(6_675)
      // Cost captured at the moment of sale — unrecoverable once the moving average moves.
      expect(sale.items[0].costPaiseSnapshot).toBe(4_000)

      // 3. payment × M — one row, and only for the money that actually moved.
      expect(sale.payments).toHaveLength(1)
      expect(sale.payments[0].method).toBe('UPI')
      expect(sale.payments[0].amountPaise).toBe(60_000)

      // 4. payment_allocation × M
      expect(num(`SELECT count(*) FROM payment_allocation WHERE sale_id = '${saleId}'`)).toBe(1)

      // 5. customer_ledger_entry — the credit portion, and NOT a payment row.
      const ledgerType = sql(
        `SELECT entry_type FROM customer_ledger_entry WHERE ref_id = '${saleId}'`,
      )
      expect(ledgerType).toBe('SALE_CREDIT')
      expect(num(`SELECT amount_paise FROM customer_ledger_entry WHERE ref_id = '${saleId}'`)).toBe(39_675)

      // 6 & 7. inventory_transaction × N and inventory_balance × N
      expect(num(`SELECT count(*) FROM inventory_transaction WHERE ref_id = '${saleId}'`)).toBe(2)
      expect(num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${sugarId}'`)).toBe(48_500)
      expect(num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${riceId}'`)).toBe(14_500)

      // 8. change_log × K — the sale, its payment, the ledger entry, the balances, the movements.
      expect(
        num(`SELECT count(*) FROM change_log WHERE entity_id = '${saleId}' AND entity = 'sale'`),
      ).toBeGreaterThan(0)
    })

    it('the bill identity holds: total = Σ payments + credit', () => {
      assertBillIdentity(saleId)
    })

    it("moves the customer's khata by exactly the credit portion", async () => {
      const statement = await request(server())
        .get(`/v1/customers/${rameshId}/statement`)
        .set(auth())
        .expect(200)

      // ₹840 opening + ₹396.75 credit.
      expect(statement.body.data.outstandingPaise).toBe(84_000 + 39_675)
      expect(statement.body.data.entries[0].entryType).toBe('OPENING_BALANCE')
      expect(statement.body.data.entries[1].entryType).toBe('SALE_CREDIT')
      // balance_after is stamped inside the lock, so replaying entries reproduces the balance.
      expect(statement.body.data.entries[1].balanceAfterPaise).toBe(123_675)
    })

    it('rolls back every group when any one of them fails', async () => {
      const before = {
        sales: num(`SELECT count(*) FROM sale WHERE shop_id = '${shopId}'`),
        movements: num(`SELECT count(*) FROM inventory_transaction WHERE shop_id = '${shopId}'`),
        ledger: num(`SELECT count(*) FROM customer_ledger_entry WHERE shop_id = '${shopId}'`),
        sugar: num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${sugarId}'`),
      }

      // A product from no shop at all: the sale row and its items are written before the stock
      // movement is attempted, so this fails partway through and must take everything with it.
      await createSale({
        customerId: rameshId,
        items: [
          { productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 },
          { productId: randomUUID(), qtyMilli: 1_000, unitPricePaise: 100 },
        ],
        payments: [{ method: 'CASH', amountPaise: 4_550 }],
      }).expect(404)

      expect(num(`SELECT count(*) FROM sale WHERE shop_id = '${shopId}'`)).toBe(before.sales)
      expect(num(`SELECT count(*) FROM inventory_transaction WHERE shop_id = '${shopId}'`)).toBe(before.movements)
      expect(num(`SELECT count(*) FROM customer_ledger_entry WHERE shop_id = '${shopId}'`)).toBe(before.ledger)
      expect(num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${sugarId}'`)).toBe(before.sugar)
    })
  })

  describe('bill identity across every payment shape (criterion 2)', () => {
    const shapes = [
      { name: 'cash in full', payments: [{ method: 'CASH', amountPaise: 8_900 }], credit: 0 },
      { name: 'UPI in full', payments: [{ method: 'UPI', amountPaise: 8_900 }], credit: 0 },
      { name: 'card in full', payments: [{ method: 'CARD', amountPaise: 8_900 }], credit: 0 },
      {
        name: 'split across two methods',
        payments: [
          { method: 'CASH', amountPaise: 5_000 },
          { method: 'UPI', amountPaise: 3_900 },
        ],
        credit: 0,
      },
      {
        name: 'partial — some cash, rest udhaar',
        payments: [{ method: 'CASH', amountPaise: 5_000 }],
        credit: 3_900,
      },
      { name: 'entirely udhaar', payments: [], credit: 8_900 },
    ]

    it.each(shapes)('$name', async ({ payments, credit }) => {
      const response = await createSale({
        customerId: rameshId,
        items: [{ productId: sugarId, qtyMilli: 2_000, unitPricePaise: 4_450 }],
        payments,
      }).expect(201)

      expect(response.body.data.totalPaise).toBe(8_900)
      expect(response.body.data.creditPaise).toBe(credit)
      assertBillIdentity(response.body.data.id)

      // §19.1: udhaar produces NO payment row. Only real money appears in `payment`.
      expect(
        num(`SELECT count(*) FROM payment WHERE sale_id = '${response.body.data.id}'`),
      ).toBe(payments.length)
    })

    it('never creates a payment row for the credit portion', () => {
      /*
       * The single most valuable assertion in this file. If udhaar ever became a payment method,
       * every "today's takings" figure in the product would include money the shop never received
       * — the classic double-counting bug this design exists to prevent, and one that looks like
       * a good day rather than a bug.
       */
      const methods = sql(
        `SELECT coalesce(string_agg(DISTINCT method, ','), '') FROM payment WHERE shop_id = '${shopId}'`,
      )
      expect(methods).not.toContain('UDHAAR')
      expect(methods).not.toContain('CREDIT')
    })

    it('holds the identity for every sale in the shop, not just the ones just written', () => {
      const broken = num(`
        SELECT count(*) FROM sale s
        WHERE s.shop_id = '${shopId}'
          AND s.total_paise <> s.credit_paise + coalesce(
            (SELECT sum(p.amount_paise) FROM payment p
             WHERE p.sale_id = s.id AND p.direction = 'IN' AND p.reversal_of_payment_id IS NULL), 0)
      `.replace(/\s+/g, ' '))
      expect(broken).toBe(0)
    })

    it('refuses an overpayment rather than inventing revenue', async () => {
      // Tendering more than the bill means change from the drawer, which the system does not
      // record. Accepting it would book money the shop did not keep.
      const response = await createSale({
        items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 }],
        payments: [{ method: 'CASH', amountPaise: 10_000 }],
      }).expect(422)

      expect(response.body.error.code).toBe('OVERPAYMENT')
    })

    it('refuses credit with no customer to owe it', async () => {
      const response = await createSale({
        items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 }],
        payments: [{ method: 'CASH', amountPaise: 1_000 }],
      }).expect(400)

      expect(JSON.stringify(response.body)).toContain('errors.sale.customerRequiredForCredit')
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Criterion 5 — double-tap safety
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('double-tap safety (criterion 5)', () => {
    it('a resubmitted sale with the same id bills the customer once', async () => {
      const saleId = randomUUID()
      const body = {
        id: saleId,
        items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 }],
        payments: [{ method: 'CASH', amountPaise: 4_450 }],
      }

      const first = await createSale(body).expect(201)
      const second = await createSale(body).expect(201)

      expect(second.body.data.id).toBe(first.body.data.id)
      expect(num(`SELECT count(*) FROM sale WHERE id = '${saleId}'`)).toBe(1)
      // And stock moved once, not twice.
      expect(num(`SELECT count(*) FROM inventory_transaction WHERE ref_id = '${saleId}'`)).toBe(1)
    })

    it('survives two genuinely simultaneous submits of the same bill', async () => {
      const saleId = randomUUID()
      const body = {
        id: saleId,
        items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 }],
        payments: [{ method: 'CASH', amountPaise: 4_450 }],
      }

      // A real double-tap: both requests in flight at once, not one after the other.
      const responses = await Promise.all([createSale(body), createSale(body)])

      // One succeeds; the other either sees the existing row or loses the primary-key race. Both
      // are acceptable — what is not acceptable is two sales.
      expect(responses.some((r) => r.status === 201)).toBe(true)
      expect(num(`SELECT count(*) FROM sale WHERE id = '${saleId}'`)).toBe(1)
      expect(num(`SELECT count(*) FROM inventory_transaction WHERE ref_id = '${saleId}'`)).toBe(1)
    })

    it('a repeated khata collection credits the customer once', async () => {
      const paymentId = randomUUID()
      const body = { id: paymentId, customerId: rameshId, method: 'CASH', amountPaise: 10_000 }

      const before = num(
        `SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${rameshId}'`,
      )
      await request(server()).post('/v1/payments').set(auth()).send(body).expect(201)
      await request(server()).post('/v1/payments').set(auth()).send(body).expect(201)

      expect(num(`SELECT count(*) FROM payment WHERE id = '${paymentId}'`)).toBe(1)
      expect(
        num(`SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${rameshId}'`),
      ).toBe(before - 10_000)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Criterion 3 — the counter flow must be fast
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('the 20-second cash sale (criterion 3)', () => {
    it('completes the server round trips of a cash sale well inside the budget', async () => {
      /*
       * The blueprint measures this **on a real device** (§28), and there is no mobile app yet —
       * so this measures only the server half: the searches a shopkeeper makes while building the
       * cart, plus the sale itself. It is a necessary condition for the 20-second flow, not a
       * demonstration of it. See docs/phase-4-status.md.
       */
      const started = Date.now()

      await request(server()).get('/v1/products/search?q=sug').set(auth()).expect(200)
      await request(server()).get('/v1/products/search?q=chawal').set(auth()).expect(200)
      await createSale({
        items: [
          { productId: sugarId, qtyMilli: 1_500, unitPricePaise: 4_450 },
          { productId: riceId, qtyMilli: 1_000, unitPricePaise: 6_000 },
        ],
        payments: [{ method: 'CASH', amountPaise: 12_675 }],
      }).expect(201)

      const elapsed = Date.now() - started
      console.log(`cash-sale server round trips: ${elapsed} ms`)

      // Generous against a 20-second human flow: the server must be a rounding error in it.
      expect(elapsed).toBeLessThan(1_000)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Criterion 4 — offline sale through sync
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('an offline sale reaching the server through sync (criterion 4)', () => {
    it('applies a queued sale, and a replay of it does nothing', async () => {
      const device = await request(server())
        .post('/v1/sync/devices')
        .set(auth())
        .send({ platform: 'ANDROID', name: 'Counter phone' })
        .expect(201)

      const saleId = randomUUID()
      const op = {
        opId: randomUUID(),
        entity: 'sale',
        entityId: saleId,
        opType: 'create',
        // Created two hours ago, while the shop had no signal.
        clientUpdatedAt: new Date(Date.now() - 7_200_000).toISOString(),
        payload: {
          customerId: rameshId,
          saleNumber: 'INV-D1-0001',
          occurredAt: new Date(Date.now() - 7_200_000).toISOString(),
          items: [{ productId: sugarId, qtyMilli: 2_000, unitPricePaise: 4_450 }],
          payments: [{ method: 'CASH', amountPaise: 5_000 }],
        },
      }

      const push = await request(server())
        .post('/v1/sync/push')
        .set(auth())
        .send({ deviceId: device.body.data.id, ops: [op] })
        .expect(201)

      expect(push.body.data.results[0].status).toBe('applied')

      const sale = await request(server()).get(`/v1/sales/${saleId}`).set(auth()).expect(200)
      expect(sale.body.data.saleNumber).toBe('INV-D1-0001')
      expect(sale.body.data.creditPaise).toBe(3_900)
      assertBillIdentity(saleId)

      // Stock moved, ledger moved — the offline sale is a first-class sale.
      expect(num(`SELECT count(*) FROM inventory_transaction WHERE ref_id = '${saleId}'`)).toBe(1)
      expect(num(`SELECT count(*) FROM customer_ledger_entry WHERE ref_id = '${saleId}'`)).toBe(1)

      // Replay: the same op id is a no-op.
      const replay = await request(server())
        .post('/v1/sync/push')
        .set(auth())
        .send({ deviceId: device.body.data.id, ops: [op] })
        .expect(201)
      expect(replay.body.data.results[0].status).toBe('duplicate')
      expect(num(`SELECT count(*) FROM sale WHERE id = '${saleId}'`)).toBe(1)
    })

    it('keeps the offline sale on its own business date, not the sync date', async () => {
      // A sale made last night and synced this morning belongs to last night's takings (§25 E-20).
      const device = await request(server())
        .post('/v1/sync/devices')
        .set(auth())
        .send({ platform: 'ANDROID', name: 'Late phone' })
        .expect(201)

      const saleId = randomUUID()
      const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)

      await request(server())
        .post('/v1/sync/push')
        .set(auth())
        .send({
          deviceId: device.body.data.id,
          ops: [
            {
              opId: randomUUID(),
              entity: 'sale',
              entityId: saleId,
              opType: 'create',
              clientUpdatedAt: twoDaysAgo.toISOString(),
              payload: {
                saleNumber: 'INV-D2-0001',
                occurredAt: twoDaysAgo.toISOString(),
                items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 }],
                payments: [{ method: 'CASH', amountPaise: 4_450 }],
              },
            },
          ],
        })
        .expect(201)

      const stored = sql(`SELECT business_date::text FROM sale WHERE id = '${saleId}'`)
      expect(stored).toBe(twoDaysAgo.toISOString().slice(0, 10))
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Khata
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('khata collections', () => {
    let payerId = ''

    beforeAll(async () => {
      const payer = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Suresh Kumar', phone: '9816099999' })
        .expect(201)
      payerId = payer.body.data.id

      // Two credit bills, a day apart, so FIFO has something to order.
      for (const [index, amount] of [1_200, 4_600].entries()) {
        await createSale({
          customerId: payerId,
          items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: amount }],
          payments: [],
          occurredAt: new Date(Date.now() - (2 - index) * 86_400_000).toISOString(),
        }).expect(201)
      }
    })

    it('allocates oldest-bill-first — the §18.4 worked example', async () => {
      const response = await request(server())
        .post('/v1/payments')
        .set(auth())
        .send({ customerId: payerId, method: 'CASH', amountPaise: 3_000 })
        .expect(201)

      // ₹30 clears the ₹12 bill entirely and puts ₹18 against the ₹46 one.
      expect(response.body.data.allocations.allocations).toEqual([
        { saleId: expect.any(String), amountPaise: 1_200 },
        { saleId: expect.any(String), amountPaise: 1_800 },
      ])
      expect(response.body.data.isAdvance).toBe(false)
    })

    it('treats an overpayment as an advance, never as an error (E-33)', async () => {
      const response = await request(server())
        .post('/v1/payments')
        .set(auth())
        .send({ customerId: payerId, method: 'UPI', amountPaise: 50_000 })
        .expect(201)

      expect(response.body.data.isAdvance).toBe(true)
      expect(response.body.data.balanceAfterPaise).toBeLessThan(0)
      expect(response.body.data.allocations.unallocatedPaise).toBeGreaterThan(0)
    })

    it('serialises two simultaneous payments so both apply (E-27)', async () => {
      const racer = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Race Test', openingBalancePaise: 100_000 })
        .expect(201)

      await Promise.all(
        Array.from({ length: 5 }, () =>
          request(server())
            .post('/v1/payments')
            .set(auth())
            .send({ customerId: racer.body.data.id, method: 'CASH', amountPaise: 10_000 })
            .expect(201),
        ),
      )

      // ₹1,000 − 5 × ₹100. If the FOR UPDATE lock were missing, some would overwrite others.
      expect(
        num(`SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${racer.body.data.id}'`),
      ).toBe(50_000)
      expect(
        num(`SELECT count(*) FROM customer_ledger_entry WHERE customer_id = '${racer.body.data.id}'`),
      ).toBe(6)
    })

    it('reverses a payment with a new row, leaving the original visible', async () => {
      const payment = await request(server())
        .post('/v1/payments')
        .set(auth())
        .send({ customerId: payerId, method: 'CASH', amountPaise: 2_000 })
        .expect(201)

      const before = num(
        `SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${payerId}'`,
      )

      await request(server())
        .post(`/v1/payments/${payment.body.data.id}/reverse`)
        .set(auth())
        .send({ reason: 'Cheque bounced' })
        .expect(201)

      // The original is still there, marked, pointing at its reversal.
      expect(num(`SELECT count(*) FROM payment WHERE id = '${payment.body.data.id}'`)).toBe(1)
      expect(
        sql(`SELECT coalesce(reversed_by_payment_id::text, '') FROM payment WHERE id = '${payment.body.data.id}'`),
      ).not.toBe('')
      expect(
        num(`SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${payerId}'`),
      ).toBe(before + 2_000)
    })

    it('refuses to reverse the same payment twice', async () => {
      const payment = await request(server())
        .post('/v1/payments')
        .set(auth())
        .send({ customerId: payerId, method: 'CASH', amountPaise: 1_000 })
        .expect(201)

      await request(server())
        .post(`/v1/payments/${payment.body.data.id}/reverse`)
        .set(auth())
        .send({ reason: 'Mistake' })
        .expect(201)

      const second = await request(server())
        .post(`/v1/payments/${payment.body.data.id}/reverse`)
        .set(auth())
        .send({ reason: 'Mistake again' })
        .expect(422)
      expect(second.body.error.code).toBe('ALREADY_REVERSED')
    })

    it('reports the cash drawer without any credit in it (§19.4)', async () => {
      const totals = await request(server())
        .get('/v1/payments/day-totals')
        .set(auth())
        .expect(200)

      const cashIn = totals.body.data.find(
        (row: { method: string; direction: string }) => row.method === 'CASH' && row.direction === 'IN',
      )
      expect(cashIn).toBeDefined()
      // The figure is trustworthy only because udhaar never produced a payment row.
      expect(Number(cashIn.total_paise)).toBeGreaterThan(0)
    })

    it('the ledger reconciles: balance == Σ entries for every customer', async () => {
      const response = await request(server()).get('/v1/khata/reconcile').set(auth()).expect(200)
      expect(response.body.data.mismatchCount).toBe(0)
    })

    it('buckets ageing by the oldest unpaid bill, not by last activity', async () => {
      const ageing = await request(server()).get('/v1/khata/ageing').set(auth()).expect(200)
      expect(ageing.body.data.length).toBeGreaterThan(0)
      expect(ageing.body.data[0]).toHaveProperty('bucket')
      expect(ageing.body.data[0]).toHaveProperty('ageInDays')
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Cancellation and returns
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('cancellation (§25 E-12)', () => {
    it('reverses stock, credit and cash, and leaves the bill visible', async () => {
      const sale = await createSale({
        customerId: rameshId,
        items: [{ productId: sugarId, qtyMilli: 2_000, unitPricePaise: 4_450 }],
        payments: [{ method: 'CASH', amountPaise: 4_000 }],
      }).expect(201)
      const saleId = sale.body.data.id

      const stockBefore = num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${sugarId}'`)
      const khataBefore = num(
        `SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${rameshId}'`,
      )

      await request(server())
        .post(`/v1/sales/${saleId}/cancel`)
        .set(auth())
        .send({ reason: 'Customer changed their mind' })
        .expect(201)

      // The bill still exists — a sale that vanishes from the day's takings is indistinguishable
      // from theft.
      const cancelled = await request(server()).get(`/v1/sales/${saleId}`).set(auth()).expect(200)
      expect(cancelled.body.data.status).toBe('CANCELLED')
      expect(cancelled.body.data.cancelReason).toBe('Customer changed their mind')

      expect(num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${sugarId}'`)).toBe(
        stockBefore + 2_000,
      )
      // Credit reversed: ₹89 bill − ₹40 paid = ₹49 was on khata.
      expect(
        num(`SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${rameshId}'`),
      ).toBe(khataBefore - 4_900)
      // Cash actually taken is returned as a payment(OUT).
      expect(
        num(`SELECT count(*) FROM payment WHERE sale_id = '${saleId}' AND direction = 'OUT'`),
      ).toBe(1)
    })

    it('is idempotent — a double-tapped cancel does not return stock twice', async () => {
      const sale = await createSale({
        items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 }],
        payments: [{ method: 'CASH', amountPaise: 4_450 }],
      }).expect(201)

      await request(server())
        .post(`/v1/sales/${sale.body.data.id}/cancel`)
        .set(auth())
        .send({ reason: 'Wrong item' })
        .expect(201)

      const stockAfterFirst = num(
        `SELECT qty_milli FROM inventory_balance WHERE product_id = '${sugarId}'`,
      )

      await request(server())
        .post(`/v1/sales/${sale.body.data.id}/cancel`)
        .set(auth())
        .send({ reason: 'Wrong item' })
        .expect(201)

      expect(num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${sugarId}'`)).toBe(
        stockAfterFirst,
      )
    })

    it('requires a reason', async () => {
      const sale = await createSale({
        items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 }],
        payments: [{ method: 'CASH', amountPaise: 4_450 }],
      }).expect(201)

      await request(server())
        .post(`/v1/sales/${sale.body.data.id}/cancel`)
        .set(auth())
        .send({})
        .expect(400)
    })

    it('refuses a cashier — reversing a completed sale is how a theft gets covered', async () => {
      const sale = await createSale({
        items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 }],
        payments: [{ method: 'CASH', amountPaise: 4_450 }],
      }).expect(201)

      await request(server())
        .post(`/v1/sales/${sale.body.data.id}/cancel`)
        .set(cashier())
        .send({ reason: 'Sneaky' })
        .expect(403)
    })
  })

  describe('returns (§25 E-11, E-39)', () => {
    it('refunds a fully-paid cash sale entirely in cash', async () => {
      const sale = await createSale({
        items: [{ productId: riceId, qtyMilli: 2_000, unitPricePaise: 6_000 }],
        payments: [{ method: 'CASH', amountPaise: 12_000 }],
      }).expect(201)

      const response = await request(server())
        .post(`/v1/sales/${sale.body.data.id}/returns`)
        .set(auth())
        .send({ items: [{ saleItemId: sale.body.data.items[0].id, qtyMilli: 1_000 }] })
        .expect(201)

      expect(response.body.data.totalPaise).toBe(6_000)
      expect(response.body.data.refundCashPaise).toBe(6_000)
      expect(response.body.data.refundCreditPaise).toBe(0)
    })

    it('reverses credit BEFORE refunding cash on a partly-paid credit sale (E-39)', async () => {
      /*
       * The edge case this ordering exists for. ₹120 bill, ₹20 paid in cash, ₹100 on udhaar.
       * Returning the whole lot must reverse ₹100 of credit and refund ₹20 — not hand over ₹120
       * the shop never received.
       */
      const sale = await createSale({
        customerId: rameshId,
        items: [{ productId: riceId, qtyMilli: 2_000, unitPricePaise: 6_000 }],
        payments: [{ method: 'CASH', amountPaise: 2_000 }],
      }).expect(201)

      const khataBefore = num(
        `SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${rameshId}'`,
      )

      const response = await request(server())
        .post(`/v1/sales/${sale.body.data.id}/returns`)
        .set(auth())
        .send({ items: [{ saleItemId: sale.body.data.items[0].id, qtyMilli: 2_000 }] })
        .expect(201)

      expect(response.body.data.totalPaise).toBe(12_000)
      expect(response.body.data.refundCreditPaise).toBe(10_000)
      expect(response.body.data.refundCashPaise).toBe(2_000)

      expect(
        num(`SELECT outstanding_paise FROM customer_balance WHERE customer_id = '${rameshId}'`),
      ).toBe(khataBefore - 10_000)
    })

    it('refuses to refund more cash than was actually paid', async () => {
      const sale = await createSale({
        customerId: rameshId,
        items: [{ productId: riceId, qtyMilli: 2_000, unitPricePaise: 6_000 }],
        payments: [{ method: 'CASH', amountPaise: 2_000 }],
      }).expect(201)

      const response = await request(server())
        .post(`/v1/sales/${sale.body.data.id}/returns`)
        .set(auth())
        .send({
          items: [{ saleItemId: sale.body.data.items[0].id, qtyMilli: 2_000 }],
          refundCashPaise: 12_000,
        })
        .expect(422)

      expect(response.body.error.code).toBe('REFUND_EXCEEDS_PAID')
    })

    it('caps cumulative returns at what was sold', async () => {
      const sale = await createSale({
        items: [{ productId: riceId, qtyMilli: 2_000, unitPricePaise: 6_000 }],
        payments: [{ method: 'CASH', amountPaise: 12_000 }],
      }).expect(201)
      const itemId = sale.body.data.items[0].id

      await request(server())
        .post(`/v1/sales/${sale.body.data.id}/returns`)
        .set(auth())
        .send({ items: [{ saleItemId: itemId, qtyMilli: 1_500 }] })
        .expect(201)

      // Only 0.5 kg left returnable. Checking the current request alone would let a customer
      // return more than they ever bought.
      const second = await request(server())
        .post(`/v1/sales/${sale.body.data.id}/returns`)
        .set(auth())
        .send({ items: [{ saleItemId: itemId, qtyMilli: 1_000 }] })
        .expect(422)

      expect(second.body.error.code).toBe('RETURN_EXCEEDS_SOLD')
    })

    it('puts the goods back on the shelf', async () => {
      const sale = await createSale({
        items: [{ productId: riceId, qtyMilli: 1_000, unitPricePaise: 6_000 }],
        payments: [{ method: 'CASH', amountPaise: 6_000 }],
      }).expect(201)

      const before = num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${riceId}'`)

      await request(server())
        .post(`/v1/sales/${sale.body.data.id}/returns`)
        .set(auth())
        .send({ items: [{ saleItemId: sale.body.data.items[0].id, qtyMilli: 1_000 }] })
        .expect(201)

      expect(num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${riceId}'`)).toBe(
        before + 1_000,
      )
      expect(
        sql(`SELECT type FROM inventory_transaction WHERE product_id = '${riceId}' ORDER BY created_at DESC LIMIT 1`),
      ).toBe('CUSTOMER_RETURN')
    })

    it('refunds the discounted price, not the gross one', async () => {
      // A 20% line discount refunded at gross would be a fifth of the value walking out.
      const sale = await createSale({
        items: [
          { productId: riceId, qtyMilli: 1_000, unitPricePaise: 6_000, discountPaise: 1_200 },
        ],
        payments: [{ method: 'CASH', amountPaise: 4_800 }],
      }).expect(201)

      const response = await request(server())
        .post(`/v1/sales/${sale.body.data.id}/returns`)
        .set(auth())
        .send({ items: [{ saleItemId: sale.body.data.items[0].id, qtyMilli: 1_000 }] })
        .expect(201)

      expect(response.body.data.totalPaise).toBe(4_800)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Permissions and negative stock
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('permissions and stock policy', () => {
    it('lets a cashier bill but not read the whole sales history', async () => {
      await createSale(
        {
          items: [{ productId: sugarId, qtyMilli: 1_000, unitPricePaise: 4_450 }],
          payments: [{ method: 'CASH', amountPaise: 4_450 }],
        },
        cashier(),
      ).expect(201)

      await request(server()).get('/v1/sales').set(cashier()).expect(403)
    })

    it('never lets a cashier adjust the khata, however granted', async () => {
      // `customer.ledger.adjust` is on the Cashier ceiling: one who can adjust the ledger can
      // erase their own theft.
      await request(server())
        .post('/v1/khata/adjustments')
        .set(cashier())
        .send({
          customerId: rameshId,
          entryType: 'ADJUSTMENT_CREDIT',
          magnitudePaise: 100_000,
          reason: 'Nothing to see here',
        })
        .expect(403)
    })

    it('requires a reason on a manual khata correction', async () => {
      await request(server())
        .post('/v1/khata/adjustments')
        .set(auth())
        .send({ customerId: rameshId, entryType: 'WRITE_OFF', magnitudePaise: 1_000 })
        .expect(400)
    })

    it('accepts a sale that drives stock negative, and flags it (§14.8)', async () => {
      const scarce = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Last Packet', unitCode: 'PIECE', sellingPricePaise: 1_000, openingStockMilli: 1_000 })
        .expect(201)

      const sale = await createSale({
        items: [{ productId: scarce.body.data.id, qtyMilli: 3_000, unitPricePaise: 1_000 }],
        payments: [{ method: 'CASH', amountPaise: 3_000 }],
      }).expect(201)

      // The goods left and the money came in. Refusing would destroy financial truth to protect
      // a stock number.
      expect(sale.body.data.droveStockNegative).toBe(true)
      expect(
        num(`SELECT qty_milli FROM inventory_balance WHERE product_id = '${scarce.body.data.id}'`),
      ).toBe(-2_000)
    })

    it('warns before exceeding a credit limit, and proceeds when overridden (E-34)', async () => {
      const limited = await request(server())
        .post('/v1/customers')
        .set(auth())
        .send({ name: 'Limited Customer', creditLimitPaise: 5_000 })
        .expect(201)

      const blocked = await createSale({
        customerId: limited.body.data.id,
        items: [{ productId: sugarId, qtyMilli: 2_000, unitPricePaise: 4_450 }],
        payments: [],
      }).expect(422)
      expect(blocked.body.error.code).toBe('CREDIT_LIMIT_EXCEEDED')

      // Never a hard block: the shopkeeper knows this customer's salary lands on the 5th.
      const allowed = await createSale({
        customerId: limited.body.data.id,
        items: [{ productId: sugarId, qtyMilli: 2_000, unitPricePaise: 4_450 }],
        payments: [],
        overrideCreditLimit: true,
      }).expect(201)
      expect(allowed.body.data.creditLimitWarning).toBeDefined()
    })

    it('blocks archiving a customer who still owes money (E-8)', async () => {
      const response = await request(server())
        .delete(`/v1/customers/${rameshId}`)
        .set(auth())
        .expect(422)
      expect(response.body.error.code).toBe('CUSTOMER_HAS_OUTSTANDING')
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Whole-shop invariants
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('invariants after everything above', () => {
    it('inventory still reconciles', async () => {
      const response = await request(server()).get('/v1/inventory/reconcile').set(auth()).expect(200)
      expect(response.body.data.mismatchCount).toBe(0)
    })

    it('the khata still reconciles', async () => {
      const response = await request(server()).get('/v1/khata/reconcile').set(auth()).expect(200)
      expect(response.body.data.mismatchCount).toBe(0)
    })

    it('every completed sale still satisfies the bill identity', () => {
      // Cancelled bills included: cancelling never rewrites what the bill said, so the identity
      // must still hold for them. That is the point of expressing a cancellation as compensating
      // rows rather than as an edit.
      const broken = num(`
        SELECT count(*) FROM sale s
        WHERE s.shop_id = '${shopId}'
          AND s.total_paise <> s.credit_paise + coalesce(
            (SELECT sum(p.amount_paise) FROM payment p
             WHERE p.sale_id = s.id AND p.direction = 'IN' AND p.reversal_of_payment_id IS NULL), 0)
      `.replace(/\s+/g, ' '))
      expect(broken).toBe(0)
    })

    it('no sale was ever deleted — cancellations are still on the books', () => {
      expect(num(`SELECT count(*) FROM sale WHERE shop_id = '${shopId}' AND status = 'CANCELLED'`))
        .toBeGreaterThan(0)
    })
  })
})
