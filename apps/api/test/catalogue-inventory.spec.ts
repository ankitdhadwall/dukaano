import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { createTestApp, nextPhone, prepareTestDatabase, truncateAll } from './harness'

/**
 * Phase 2 — Catalogue & Inventory.
 *
 * Acceptance criteria under test:
 *   1. product search returns in under 100 ms at 5,000 products
 *   2. every stock change produces an inventory transaction
 *   3. balance == Σ transactions, always
 */
describe('catalogue and inventory', () => {
  let app: INestApplication
  let token = ''
  let cashierToken = ''
  let sugarId = ''
  let shopId = ''

  const auth = () => ({ Authorization: `Bearer ${token}` })
  const server = () => app.getHttpServer()

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
    const cashierLogin = await request(server())
      .post('/v1/auth/login')
      .send({ phone: cashierPhone, password: 'temp pass 1234' })
      .expect(200)
    cashierToken = cashierLogin.body.data.accessToken

    const sugar = await request(server())
      .post('/v1/products')
      .set(auth())
      .send({
        nameEn: 'Sugar Loose',
        nameHi: 'चीनी (खुली)',
        sku: 'SUG01',
        shortCode: 'SUG',
        unitCode: 'KG',
        sellingPricePaise: 5000,
        purchasePricePaise: 4400,
        lowStockThresholdMilli: 5_000,
        openingStockMilli: 40_000,
        aliases: ['chini', 'cheeni', 'shakkar'],
      })
      .expect(201)
    sugarId = sugar.body.data.id
  }, 180_000)

  afterAll(async () => {
    await app?.close()
  })

  describe('product creation', () => {
    it('writes opening stock as a transaction, never as a bare balance', async () => {
      const stock = await request(server())
        .get(`/v1/inventory/products/${sugarId}`)
        .set(auth())
        .expect(200)

      expect(stock.body.data.qtyMilli).toBe(40_000)
      expect(stock.body.data.history).toHaveLength(1)
      expect(stock.body.data.history[0].type).toBe('OPENING_STOCK')
      expect(stock.body.data.history[0].balanceAfterMilli).toBe(40_000)
      // Opening stock seeds the moving average from the purchase price.
      expect(stock.body.data.avgCostPaise).toBe(4400)
      // 40 kg at ₹44/kg = ₹1,760 — note the /1000 for the quantity scale.
      expect(stock.body.data.stockValuePaise).toBe(176_000)
    })

    it('accepts a product named only in Hindi', async () => {
      const res = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameHi: 'हल्दी पाउडर', unitCode: 'PACKET', sellingPricePaise: 3000 })
        .expect(201)
      expect(res.body.data.nameHi).toBe('हल्दी पाउडर')
      expect(res.body.data.nameEn).toBeNull()
    })

    it('rejects a product with no name in either language', async () => {
      const res = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ unitCode: 'PIECE', sellingPricePaise: 1000 })
      expect(res.status).toBe(400)
      expect(JSON.stringify(res.body.error.fieldErrors)).toContain('errors.product.nameRequired')
    })

    it('rejects a duplicate SKU, naming the product it clashes with', async () => {
      const res = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Sugar Packet', sku: 'SUG01', unitCode: 'PACKET', sellingPricePaise: 5200 })
      expect(res.status).toBe(409)
      expect(res.body.error.messageKey).toBe('errors.product.duplicateSku')
      expect(res.body.error.params.existing).toBe('Sugar Loose')
    })

    it('rejects fractional opening stock on a whole-number unit', async () => {
      // "1.5 pieces" is rejected at the source rather than silently truncated (§25 E-22).
      const res = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Candle', unitCode: 'PIECE', sellingPricePaise: 1000, openingStockMilli: 1500 })
      expect(res.status).toBe(400)
    })

    it('allows fractional stock on a weighed unit', async () => {
      const res = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Toor Dal', unitCode: 'KG', sellingPricePaise: 18_000, openingStockMilli: 20_500 })
        .expect(201)
      expect(res.body.data.balance.qtyMilli).toBe(20_500)
    })
  })

  describe('search — the billing hot path', () => {
    it('finds a product by English name prefix', async () => {
      const res = await request(server()).get('/v1/products/search?q=sug').set(auth()).expect(200)
      expect(res.body.data[0].nameEn).toBe('Sugar Loose')
    })

    it('finds it by SKU and by short code', async () => {
      for (const term of ['SUG01', 'SUG', 'sug01']) {
        const res = await request(server())
          .get(`/v1/products/search?q=${term}`)
          .set(auth())
          .expect(200)
        expect(res.body.data[0]?.sku, `searching "${term}"`).toBe('SUG01')
      }
    })

    it('finds it by romanized Hindi alias — the reason aliases exist', async () => {
      // A Hindi-first shopkeeper types "chini", not "Sugar" and not "चीनी". Without the alias
      // index, search silently fails for exactly the audience the product is built for.
      for (const term of ['chini', 'cheeni', 'shakkar']) {
        const res = await request(server())
          .get(`/v1/products/search?q=${term}`)
          .set(auth())
          .expect(200)
        expect(res.body.data[0]?.nameEn, `searching "${term}"`).toBe('Sugar Loose')
      }
    })

    it('finds it by Devanagari name', async () => {
      const res = await request(server())
        .get(`/v1/products/search?q=${encodeURIComponent('चीनी')}`)
        .set(auth())
        .expect(200)
      expect(res.body.data[0].nameHi).toBe('चीनी (खुली)')
    })

    it('ranks an exact short-code match above a name match', async () => {
      await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Sugar Free Sweetener', shortCode: 'SFS', unitCode: 'PIECE', sellingPricePaise: 25_000 })
        .expect(201)

      // "SUG" is Sugar Loose's short code; it must win over the alphabetically-earlier
      // "Sugar Free Sweetener", because the shopkeeper typed a code.
      const res = await request(server()).get('/v1/products/search?q=SUG').set(auth()).expect(200)
      expect(res.body.data[0].shortCode).toBe('SUG')
    })

    it('returns recent products for an empty query', async () => {
      const res = await request(server()).get('/v1/products/search?q=').set(auth()).expect(200)
      expect(res.body.data.length).toBeGreaterThan(0)
    })

    it('is available to a Cashier, who cannot bill without it', async () => {
      const res = await request(server())
        .get('/v1/products/search?q=sug')
        .set({ Authorization: `Bearer ${cashierToken}` })
        .expect(200)
      expect(res.body.data.length).toBeGreaterThan(0)
    })

    it('returns in under 100 ms at 5,000 products', async () => {
      /*
       * Acceptance criterion: search under 100 ms at 5,000 products.
       *
       * The rows are inserted in one bulk statement rather than through 5,000 HTTP POSTs. What
       * is under test is the *read* path — the trigram index, the ranking CASE and the balance
       * join — and those behave identically regardless of how the rows arrived. Driving 5,000
       * creates through the API would also exhaust the connection pool, since every create opens
       * its own tenant transaction.
       */
      const { PrismaService } = await import('../src/common/prisma/prisma.service')
      const prisma = app.get(PrismaService)

      await prisma.withTenant(shopId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO product (
            id, shop_id, name_en, name_hi, sku, unit_code, selling_price_paise,
            low_stock_threshold_milli, tax_rate_bp, is_active, row_version, created_at, updated_at
          )
          SELECT gen_random_uuid(), ${shopId}::uuid,
                 'Bulk Product ' || g, 'उत्पाद ' || g, 'BULK-' || g,
                 'PIECE', 1000 + g, 0, 0, true, 1, now(), now()
          FROM generate_series(1, 5000) g
        `
        await tx.$executeRaw`ANALYZE product`
      })

      const counted = await request(server()).get('/v1/products/search?q=Bulk&limit=50').set(auth())
      expect(counted.status).toBe(200)
      expect(counted.body.data).toHaveLength(50)

      const timings: number[] = []
      for (const term of ['sug', 'chini', 'bulk product 4', 'SUG01', 'माल', 'parle']) {
        const started = performance.now()
        await request(server()).get(`/v1/products/search?q=${encodeURIComponent(term)}`).set(auth())
        timings.push(performance.now() - started)
      }

      const worst = Math.max(...timings)
      console.log(
        `      search latency at 5,000 products — ` +
          `worst ${worst.toFixed(1)} ms, median ${[...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)]?.toFixed(1)} ms`,
      )
      // Includes HTTP, guard, the per-request membership lookup and the tenant transaction —
      // not just the SQL. The real query is a fraction of this.
      expect(worst, `slowest search was ${worst.toFixed(1)} ms`).toBeLessThan(100)
    }, 300_000)
  })

  describe('stock movements', () => {
    it('records an adjustment and moves the balance', async () => {
      const before = await request(server()).get(`/v1/inventory/products/${sugarId}`).set(auth())
      const res = await request(server())
        .post('/v1/inventory/adjustments')
        .set(auth())
        .send({ productId: sugarId, type: 'DAMAGE', qtyDeltaMilli: -2000, reason: 'Spillage' })
        .expect(201)

      expect(res.body.data.balanceBeforeMilli).toBe(before.body.data.qtyMilli)
      expect(res.body.data.balanceAfterMilli).toBe(before.body.data.qtyMilli - 2000)
    })

    it('refuses an adjustment with no reason — stock never changes without a trace', async () => {
      const res = await request(server())
        .post('/v1/inventory/adjustments')
        .set(auth())
        .send({ productId: sugarId, type: 'DAMAGE', qtyDeltaMilli: -1000 })
      expect(res.status).toBe(400)
    })

    it('refuses a zero movement', async () => {
      const res = await request(server())
        .post('/v1/inventory/adjustments')
        .set(auth())
        .send({ productId: sugarId, type: 'ADJUSTMENT', qtyDeltaMilli: 0, reason: 'test' })
      expect(res.status).toBe(400)
    })

    it('allows stock to go negative, and reports that it did (§17.3)', async () => {
      const created = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({
          nameEn: 'Bread',
          unitCode: 'PIECE',
          sellingPricePaise: 4500,
          openingStockMilli: 2000,
          lowStockThresholdMilli: 6000,
        })
        .expect(201)

      const res = await request(server())
        .post('/v1/inventory/adjustments')
        .set(auth())
        .send({
          productId: created.body.data.id,
          type: 'CORRECTION',
          qtyDeltaMilli: -5000,
          reason: 'Counted short at close',
        })
        .expect(201)

      // Refusing this would destroy the record of goods that physically left the shop.
      expect(res.body.data.balanceAfterMilli).toBe(-3000)
      expect(res.body.data.wentNegative).toBe(true)
    })

    it('updates the moving average on an inbound movement, weighted by quantity', async () => {
      const created = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({
          nameEn: 'Basmati Rice',
          unitCode: 'KG',
          sellingPricePaise: 12_000,
          purchasePricePaise: 10_000,
          openingStockMilli: 25_000,
        })
        .expect(201)
      const productId = created.body.data.id

      // 25 kg at ₹100 + 25 kg at ₹110 → ₹105.00
      await request(server())
        .post('/v1/inventory/adjustments')
        .set(auth())
        .send({
          productId,
          type: 'CORRECTION',
          qtyDeltaMilli: 25_000,
          reason: 'Received from Gupta Distributors',
          unitCostPaise: 11_000,
        })
        .expect(201)

      const stock = await request(server()).get(`/v1/inventory/products/${productId}`).set(auth())
      expect(stock.body.data.avgCostPaise).toBe(10_500)
      expect(stock.body.data.qtyMilli).toBe(50_000)
    })

    it('leaves the average untouched on an outbound movement', async () => {
      const before = await request(server()).get(`/v1/inventory/products/${sugarId}`).set(auth())
      await request(server())
        .post('/v1/inventory/adjustments')
        .set(auth())
        .send({ productId: sugarId, type: 'WASTAGE', qtyDeltaMilli: -500, reason: 'Weighing loss' })
        .expect(201)
      const after = await request(server()).get(`/v1/inventory/products/${sugarId}`).set(auth())
      expect(after.body.data.avgCostPaise).toBe(before.body.data.avgCostPaise)
    })

    it('serializes concurrent movements on the same product', async () => {
      // Without SELECT … FOR UPDATE, ten simultaneous deductions both read the same starting
      // quantity and the later writes silently overwrite the earlier ones.
      const created = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Parle-G', unitCode: 'PACKET', sellingPricePaise: 1000, openingStockMilli: 100_000 })
        .expect(201)
      const productId = created.body.data.id

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(server())
            .post('/v1/inventory/adjustments')
            .set(auth())
            .send({ productId, type: 'DAMAGE', qtyDeltaMilli: -1000, reason: 'Concurrency test' }),
        ),
      )
      expect(results.every((r) => r.status === 201)).toBe(true)

      const stock = await request(server()).get(`/v1/inventory/products/${productId}`).set(auth())
      expect(stock.body.data.qtyMilli).toBe(90_000)
      expect(stock.body.data.history.length).toBe(11) // opening + 10 adjustments
    })

    it('refuses a movement in the wrong direction for its type', async () => {
      // DAMAGE can only reduce stock; a positive damage is a data-entry error, not a receipt.
      const res = await request(server())
        .post('/v1/inventory/adjustments')
        .set(auth())
        .send({ productId: sugarId, type: 'DAMAGE', qtyDeltaMilli: 5000, reason: 'wrong direction' })
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('WRONG_DIRECTION')
    })

    it('hides adjustments from a Cashier', async () => {
      const res = await request(server())
        .post('/v1/inventory/adjustments')
        .set({ Authorization: `Bearer ${cashierToken}` })
        .send({ productId: sugarId, type: 'DAMAGE', qtyDeltaMilli: -1000, reason: 'nope' })
      expect(res.status).toBe(403)
    })

    it('hides valuation from a Cashier — it exposes purchase cost', async () => {
      const res = await request(server())
        .get('/v1/inventory/valuation')
        .set({ Authorization: `Bearer ${cashierToken}` })
      expect(res.status).toBe(403)
      expect(res.body.error.params.action).toBe('product.view.cost')
    })
  })

  describe('the reconciliation invariant', () => {
    it('holds after every operation this suite performed', async () => {
      // Acceptance criterion: balance == Σ transactions. Asserted at the end, after hundreds of
      // creates and adjustments, because that is when a write-path bug would have shown up.
      const res = await request(server()).get('/v1/inventory/reconcile').set(auth()).expect(200)
      expect(res.body.data.mismatchCount, JSON.stringify(res.body.data.mismatches)).toBe(0)
    })
  })

  describe('low stock', () => {
    it('lists products at or below their threshold, most urgent first', async () => {
      const res = await request(server()).get('/v1/inventory/low-stock').set(auth()).expect(200)
      const codes = res.body.data.map((r: { name_en: string }) => r.name_en)
      expect(codes).toContain('Bread') // driven to -3 kg above

      const deficits = res.body.data.map(
        (r: { qty_milli: number; low_stock_threshold_milli: number }) =>
          r.qty_milli - r.low_stock_threshold_milli,
      )
      expect([...deficits].sort((a: number, b: number) => a - b)).toEqual(deficits)
    })

    it('ignores products with no threshold configured', async () => {
      // A zero threshold means "not tracked". Treating it as "always low" would bury the real
      // alerts under every unconfigured product in the shop.
      const res = await request(server()).get('/v1/inventory/low-stock').set(auth()).expect(200)
      for (const row of res.body.data) expect(row.low_stock_threshold_milli).toBeGreaterThan(0)
    })
  })

  describe('archive and unit change', () => {
    it('blocks a unit change while stock is non-zero', async () => {
      // 45,000 milli means 45 kg under KG and 45 pieces under PIECE. Reinterpreting it silently
      // would corrupt the stock number and every valuation reading it (§25 E-37).
      const res = await request(server())
        .patch(`/v1/products/${sugarId}`)
        .set(auth())
        .send({ unitCode: 'PIECE' })
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('UNIT_CHANGE_BLOCKED')
    })

    it('archives softly, keeping the row and its history', async () => {
      const created = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Discontinued Item', unitCode: 'PIECE', sellingPricePaise: 500 })
        .expect(201)

      await request(server()).delete(`/v1/products/${created.body.data.id}`).set(auth()).expect(200)

      // Gone from search…
      const search = await request(server())
        .get('/v1/products/search?q=Discontinued')
        .set(auth())
        .expect(200)
      expect(search.body.data).toHaveLength(0)

      // …but the row survives, so historical bills still render (§25 E-9).
      const fetched = await request(server())
        .get(`/v1/products/${created.body.data.id}`)
        .set(auth())
        .expect(200)
      expect(fetched.body.data.archivedAt).not.toBeNull()
    })

    it('frees the SKU for reuse once archived', async () => {
      const first = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Old Namkeen', sku: 'REUSE-1', unitCode: 'PACKET', sellingPricePaise: 2000 })
        .expect(201)
      await request(server()).delete(`/v1/products/${first.body.data.id}`).set(auth()).expect(200)

      await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'New Namkeen', sku: 'REUSE-1', unitCode: 'PACKET', sellingPricePaise: 2500 })
        .expect(201)
    })
  })
})
