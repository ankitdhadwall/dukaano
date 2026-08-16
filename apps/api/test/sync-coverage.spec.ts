import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { appSql, createTestApp, nextPhone, prepareTestDatabase, sql, truncateAll } from './harness'

/**
 * Two structural gates that fail the build rather than leaking quietly in production.
 *
 * Both exist because of a specific mistake made while building Phase 3, not as speculation.
 */
describe('structural gates', () => {
  let app: INestApplication
  let token = ''
  let shopId = ''

  const auth = () => ({ Authorization: `Bearer ${token}` })
  const server = () => app.getHttpServer()


  const changeCount = () =>
    Number(sql(`SELECT count(*) FROM change_log WHERE shop_id = '${shopId}'`))

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
        shopName: 'Gate Test Store',
      })
      .expect(201)
    token = owner.body.data.accessToken
    shopId = owner.body.data.shop.id
  }, 120_000)

  afterAll(async () => {
    await app?.close()
  })

  /**
   * Gate 1 — every syncable mutation must append to `change_log`.
   *
   * `ChangeLogService` being ambient makes the *wiring* hard to get wrong; this catches the other
   * half, which is forgetting to call it. The failure mode it guards is silent and severe: a
   * product that exists on the server, is returned by search, looks entirely healthy — and never
   * reaches a single device, because nothing told the delta feed it happened. No error is raised
   * anywhere, and the shopkeeper's phone simply does not have it.
   *
   * A new write path that forgets the call fails here on the day it is written.
   */
  describe('every syncable write reaches the change log', () => {
    it('product create', async () => {
      const before = changeCount()
      await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Gate Product', unitCode: 'PIECE', sellingPricePaise: 100 })
        .expect(201)
      expect(changeCount()).toBeGreaterThan(before)
    })

    it('product update', async () => {
      const created = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Gate Update', unitCode: 'PIECE', sellingPricePaise: 100 })
        .expect(201)

      const before = changeCount()
      await request(server())
        .patch(`/v1/products/${created.body.data.id}`)
        .set(auth())
        .send({ sellingPricePaise: 200 })
        .expect(200)
      expect(changeCount()).toBeGreaterThan(before)
    })

    it('product archive, logged as an archive rather than an upsert', async () => {
      const created = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Gate Archive', unitCode: 'PIECE', sellingPricePaise: 100 })
        .expect(201)

      await request(server()).delete(`/v1/products/${created.body.data.id}`).set(auth()).expect(200)

      // The op matters: a device removes it from the picker rather than upserting a row it then
      // has to notice is inactive.
      expect(
        sql(
          `SELECT op FROM change_log WHERE shop_id = '${shopId}' ` +
            `AND entity_id = '${created.body.data.id}' ORDER BY id DESC LIMIT 1`,
        ),
      ).toBe('archive')
    })

    it('category create, update and archive', async () => {
      const before = changeCount()
      const created = await request(server())
        .post('/v1/categories')
        .set(auth())
        .send({ nameEn: 'Gate Category' })
        .expect(201)
      await request(server())
        .patch(`/v1/categories/${created.body.data.id}`)
        .set(auth())
        .send({ nameEn: 'Gate Category Renamed' })
        .expect(200)
      await request(server()).delete(`/v1/categories/${created.body.data.id}`).set(auth()).expect(200)

      expect(changeCount()).toBeGreaterThanOrEqual(before + 3)
    })

    it('a stock adjustment logs both the transaction and the derived balance', async () => {
      const product = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Gate Stock', unitCode: 'KG', sellingPricePaise: 100, openingStockMilli: 5_000 })
        .expect(201)

      const before = changeCount()
      await request(server())
        .post('/v1/inventory/adjustments')
        .set(auth())
        .send({
          productId: product.body.data.id,
          type: 'DAMAGE',
          qtyDeltaMilli: -1_000,
          reason: 'Spoiled in the rain',
        })
        .expect(201)

      // Two rows: the immutable fact, and the balance the device may only ever receive (§14.7).
      // A client that got only the transaction would have to recompute the balance itself and
      // would drift the moment its arithmetic differed by a paisa.
      expect(changeCount()).toBe(before + 2)

      const entities = sql(
        `SELECT string_agg(DISTINCT entity, ',' ORDER BY entity) FROM change_log ` +
          `WHERE shop_id = '${shopId}' AND id > ${before === 0 ? 0 : Number(sql(`SELECT max(id) - 2 FROM change_log WHERE shop_id = '${shopId}'`))}`,
      )
      expect(entities).toContain('inventory_balance')
      expect(entities).toContain('inventory_transaction')
    })

    it('bulk import logs every created product', async () => {
      const before = changeCount()
      const rows = Array.from({ length: 20 }, (_, i) => `Imported ${i},PIECE,50`).join('\n')

      const response = await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({
          content: `Name,Unit,Price\n${rows}\n`,
          mapping: { nameEn: 0, unitCode: 1, sellingPrice: 2 },
        })
        .expect(201)

      expect(response.body.data.createdCount).toBe(20)
      // The bulk path bypasses ProductsService, so it has to log its own changes — an imported
      // catalogue that never reaches a phone is worse than one never imported.
      expect(changeCount()).toBeGreaterThanOrEqual(before + 20)
    })

    it('master-catalogue adoption logs every adopted product', async () => {
      const browse = await request(server())
        .get('/v1/master-catalogue?commonOnly=true')
        .set(auth())
        .expect(200)
      const items = browse.body.data.products
        .slice(0, 3)
        .map((p: { id: string }) => ({ masterProductId: p.id, sellingPricePaise: 5_000 }))

      const before = changeCount()
      await request(server()).post('/v1/master-catalogue/adopt').set(auth()).send({ items }).expect(201)

      expect(changeCount()).toBeGreaterThanOrEqual(before + 3)
    })
  })

  /**
   * Gate 2 — every tenant table's RLS policy must have a `WITH CHECK` clause.
   *
   * `USING` guards reads; `WITH CHECK` guards *writes*. A policy with only `USING` lets the
   * application role INSERT a row bearing another shop's `shop_id` — the row is then invisible to
   * the shop that created it and fully visible to the victim.
   *
   * This is not hypothetical. A migration written during Phase 3 recreated the policies on
   * `change_log`, `processed_operation` and `sync_conflict` and dropped their `WITH CHECK` in the
   * process. Nothing failed: every read-path test still passed, because reads were still guarded.
   * The gate exists because the tenant-isolation suite could not catch it — that suite attacks
   * with GETs and PATCHes through the API, and this hole is only reachable by a write that names
   * a foreign shop id directly.
   */
  describe('RLS policies guard writes as well as reads', () => {
    it('every RLS-enabled tenant table has both USING and WITH CHECK', () => {
      // One line: this is shelled out to psql, and embedded newlines break the -c argument.
      const rows = sql(
        "SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') " +
          'FROM pg_class c ' +
          'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
          "LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'tenant_isolation' " +
          "WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity " +
          'AND (p.policyname IS NULL OR p.with_check IS NULL)',
      )

      expect(
        rows,
        'These tables have RLS enabled but no WITH CHECK clause, so the application role can ' +
          "INSERT rows bearing another shop's shop_id. Reads look correctly isolated while writes " +
          'are not (blueprint §13, §23.3).',
      ).toBe('')
    })

    it('proves the clause is load-bearing: a foreign shop_id insert is refused', async () => {
      // Written as the application role with a tenant context set to our shop, then attempting to
      // insert a change_log row for a different shop. WITH CHECK is the only thing stopping it.
      const foreignShopId = '00000000-0000-4000-8000-00000000beef'
      const attempt = () =>
        appSql(
          `BEGIN; SELECT set_config('app.shop_id', '${shopId}', true); ` +
            `INSERT INTO change_log (shop_id, entity, entity_id, op, row_version) ` +
            `VALUES ('${foreignShopId}', 'product', '${foreignShopId}', 'upsert', 1); COMMIT;`,
        )

      expect(attempt).toThrow(/row-level security|violates/i)
    })
  })
})
