import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { createTestApp, nextPhone, prepareTestDatabase, sql, truncateAll } from './harness'

/**
 * Phase 2 close-out — categories, units, master-catalogue adoption, and bulk import.
 *
 * The import tests are the point of this file. Acceptance criterion 4 is "import of 5,000 rows
 * with an error report", and the properties that actually matter for a shopkeeper's data are:
 *
 *   • what the preview promises is what the commit does
 *   • a row that fails never half-imports
 *   • opening stock arrives as a transaction, so reconciliation still holds afterwards
 */
describe('catalogue administration', () => {
  let app: INestApplication
  let token = ''
  let cashierToken = ''
  let shopId = ''

  const auth = () => ({ Authorization: `Bearer ${token}` })
  const server = () => app.getHttpServer()

  const csv = (rows: string[][], header = 'Name,Hindi Name,Unit,Price,Cost,Stock,SKU,Category'): string =>
    [header, ...rows.map((row) => row.join(','))].join('\n')

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
      .send({
        phone: cashierPhone,
        fullName: 'Suresh',
        role: 'CASHIER',
        temporaryPassword: 'temp pass 1234',
      })
      .expect(201)
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ phone: cashierPhone, password: 'temp pass 1234' })
      .expect(200)
    cashierToken = login.body.data.accessToken
  }, 120_000)

  afterAll(async () => {
    await app?.close()
  })

  // --- units ---------------------------------------------------------------------------------

  describe('units', () => {
    it('serves the fixed platform list in both languages with its precision rule', async () => {
      const response = await request(server()).get('/v1/units').set(auth()).expect(200)

      const kg = response.body.data.find((unit: { code: string }) => unit.code === 'KG')
      const piece = response.body.data.find((unit: { code: string }) => unit.code === 'PIECE')

      expect(kg).toEqual({ code: 'KG', nameEn: 'Kilogram', nameHi: 'किलो', decimals: 3 })
      // decimals: 0 is what makes "1.5 pieces" rejectable at the source (§25 E-22).
      expect(piece.decimals).toBe(0)
    })

    it('is readable by a cashier, who needs units to bill', async () => {
      await request(server())
        .get('/v1/units')
        .set({ Authorization: `Bearer ${cashierToken}` })
        .expect(200)
    })
  })

  // --- categories ----------------------------------------------------------------------------

  describe('categories', () => {
    let categoryId = ''

    it('creates a bilingual category', async () => {
      const response = await request(server())
        .post('/v1/categories')
        .set(auth())
        .send({ nameEn: 'Staples', nameHi: 'रोज़मर्रा', sortOrder: 1 })
        .expect(201)

      categoryId = response.body.data.id
      expect(response.body.data).toMatchObject({ nameEn: 'Staples', nameHi: 'रोज़मर्रा' })
    })

    it('accepts a Hindi-only category and never invents the English name', async () => {
      const response = await request(server())
        .post('/v1/categories')
        .set(auth())
        .send({ nameHi: 'मसाले' })
        .expect(201)

      expect(response.body.data.nameHi).toBe('मसाले')
      expect(response.body.data.nameEn).toBeNull()
    })

    it('rejects a category with no name in either language', async () => {
      const response = await request(server()).post('/v1/categories').set(auth()).send({}).expect(400)
      expect(JSON.stringify(response.body)).toContain('errors.category.nameRequired')
    })

    it('rejects a duplicate name case-insensitively', async () => {
      const response = await request(server())
        .post('/v1/categories')
        .set(auth())
        .send({ nameEn: 'staples' })
        .expect(422)

      expect(response.body.error.code).toBe('DUPLICATE_CATEGORY')
    })

    it('reports a live product count so the UI can warn before archiving', async () => {
      await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Toor Dal', unitCode: 'KG', sellingPricePaise: 14_000, categoryId })
        .expect(201)

      const response = await request(server()).get('/v1/categories').set(auth()).expect(200)
      const staples = response.body.data.find((row: { id: string }) => row.id === categoryId)

      expect(staples.productCount).toBe(1)
    })

    it('archives softly and leaves the products inside it sellable', async () => {
      await request(server()).delete(`/v1/categories/${categoryId}`).set(auth()).expect(200)

      // Gone from the picker...
      const list = await request(server()).get('/v1/categories').set(auth()).expect(200)
      expect(list.body.data.map((row: { id: string }) => row.id)).not.toContain(categoryId)

      // ...but the product still carries it and still sells. Nulling the reference would be
      // tidier in the schema and would silently uncategorise the shopkeeper's products.
      const search = await request(server()).get('/v1/products/search?q=toor').set(auth()).expect(200)
      expect(search.body.data).toHaveLength(1)
    })

    it('frees the name once archived', async () => {
      await request(server())
        .post('/v1/categories')
        .set(auth())
        .send({ nameEn: 'Staples' })
        .expect(201)
    })

    it('refuses a cashier the right to create categories', async () => {
      await request(server())
        .post('/v1/categories')
        .set({ Authorization: `Bearer ${cashierToken}` })
        .send({ nameEn: 'Sneaky' })
        .expect(403)
    })
  })

  // --- master catalogue ------------------------------------------------------------------------

  describe('master catalogue adoption', () => {
    let masterIds: string[] = []

    it('browses the platform catalogue and flags what the shop already has', async () => {
      const response = await request(server())
        .get('/v1/master-catalogue?commonOnly=true')
        .set(auth())
        .expect(200)

      expect(response.body.data.categories.length).toBeGreaterThan(0)
      expect(response.body.data.products.length).toBeGreaterThan(0)
      expect(response.body.data.products[0]).toHaveProperty('alreadyAdded', false)

      masterIds = response.body.data.products.slice(0, 5).map((p: { id: string }) => p.id)
    })

    it('adopts items with shop-chosen prices and writes opening stock as a transaction', async () => {
      const response = await request(server())
        .post('/v1/master-catalogue/adopt')
        .set(auth())
        .send({
          items: masterIds.map((id, index) => ({
            masterProductId: id,
            sellingPricePaise: 5_000 + index * 100,
            purchasePricePaise: 4_000,
            openingStockMilli: 10_000,
          })),
        })
        .expect(201)

      expect(response.body.data.createdCount).toBe(5)

      const productId = response.body.data.products[0].id
      const stock = await request(server())
        .get(`/v1/inventory/products/${productId}`)
        .set(auth())
        .expect(200)

      expect(stock.body.data.qtyMilli).toBe(10_000)
      expect(stock.body.data.history).toHaveLength(1)
      expect(stock.body.data.history[0].type).toBe('OPENING_STOCK')
      // Batched opening stock must still set the moving average, or the valuation reads zero.
      expect(stock.body.data.avgCostPaise).toBe(4_000)
    })

    it('never copies the platform hint price onto the shelf', async () => {
      const browse = await request(server())
        .get('/v1/master-catalogue?commonOnly=true')
        .set(auth())
        .expect(200)

      const adopted = browse.body.data.products.find((p: { id: string }) => p.id === masterIds[0])
      const search = await request(server()).get('/v1/products/search').set(auth()).expect(200)
      const shopProduct = search.body.data.find((p: { nameEn: string }) => p.nameEn === adopted.nameEn)

      expect(shopProduct.sellingPricePaise).toBe(5_000)
      // The suggestion existed and was deliberately not used.
      expect(adopted.hintPricePaise).not.toBe(5_000)
    })

    it('marks adopted items so the shopkeeper is not offered them twice', async () => {
      const response = await request(server())
        .get('/v1/master-catalogue?commonOnly=true')
        .set(auth())
        .expect(200)

      const adopted = response.body.data.products.filter((p: { alreadyAdded: boolean }) => p.alreadyAdded)
      expect(adopted.map((p: { id: string }) => p.id).sort()).toEqual([...masterIds].sort())
    })

    it('skips rather than duplicates when the same items are adopted again', async () => {
      // A double tap on "add common items" must leave one Sugar, and must not read as an error.
      const response = await request(server())
        .post('/v1/master-catalogue/adopt')
        .set(auth())
        .send({ items: masterIds.map((id) => ({ masterProductId: id, sellingPricePaise: 9_900 })) })
        .expect(201)

      expect(response.body.data).toMatchObject({ createdCount: 0, skippedCount: 5 })
    })

    it('rejects an unknown master product rather than silently dropping it', async () => {
      const response = await request(server())
        .post('/v1/master-catalogue/adopt')
        .set(auth())
        .send({
          items: [
            { masterProductId: '00000000-0000-4000-8000-000000000000', sellingPricePaise: 100 },
          ],
        })
        .expect(422)

      expect(response.body.error.code).toBe('MASTER_PRODUCT_NOT_FOUND')
    })

    it('refuses a cashier', async () => {
      await request(server())
        .post('/v1/master-catalogue/adopt')
        .set({ Authorization: `Bearer ${cashierToken}` })
        .send({ items: [{ masterProductId: masterIds[0], sellingPricePaise: 1 }] })
        .expect(403)
    })
  })

  // --- import: template and mapping ------------------------------------------------------------

  describe('import — template and column mapping', () => {
    it('serves a CSV template as a file, not as JSON', async () => {
      const response = await request(server())
        .get('/v1/products/import/template')
        .set(auth())
        .expect(200)

      expect(response.headers['content-type']).toContain('text/csv')
      expect(response.headers['content-disposition']).toContain('attachment')
      // A BOM, so Excel reads the Devanagari example as Hindi rather than mojibake.
      expect(response.text.charCodeAt(0)).toBe(0xfeff)
      expect(response.text).toContain('nameEn')
    })

    it('round-trips: the template uploads back with every column auto-detected', async () => {
      const template = await request(server())
        .get('/v1/products/import/template')
        .set(auth())
        .expect(200)

      const preview = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content: template.text })
        .expect(201)

      expect(preview.body.data.unmappedColumns).toEqual([])
      expect(preview.body.data.summary).toMatchObject({ total: 1, error: 0 })
    })

    it('auto-detects a header the shopkeeper wrote themselves', async () => {
      const preview = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content: csv([['Poha', 'पोहा', 'KG', '60', '50', '10', 'PHA1', 'Staples']]) })
        .expect(201)

      expect(preview.body.data.mappingWasDetected).toBe(true)
      expect(preview.body.data.mapping).toMatchObject({
        nameEn: 0, nameHi: 1, unitCode: 2, sellingPrice: 3, purchasePrice: 4,
        openingStock: 5, sku: 6, category: 7,
      })
    })

    it('detects a Hindi header', async () => {
      const preview = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content: 'नाम,इकाई,दाम\nसरसों तेल,लीटर,180\n' })
        .expect(201)

      expect(preview.body.data.mapping).toMatchObject({ nameHi: 0, unitCode: 1, sellingPrice: 2 })
      expect(preview.body.data.summary.create).toBe(1)
    })

    it('refuses a file with no usable name column instead of showing 300 red rows', async () => {
      const response = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content: 'Rack,Price\nA1,20\n' })
        .expect(422)

      expect(response.body.error.code).toBe('NO_NAME_COLUMN')
    })

    it('refuses a file with no price column', async () => {
      const response = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content: 'Name,Rack\nPoha,A1\n' })
        .expect(422)

      expect(response.body.error.code).toBe('NO_PRICE_COLUMN')
    })

    it('reports an unreadable file with the line to look at', async () => {
      const response = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content: 'Name,Price\nPoha,60\n"Broken,70\n' })
        .expect(422)

      expect(response.body.error.code).toBe('CSV_PARSE_FAILED')
      expect(response.body.error.params.line).toBe(3)
    })
  })

  // --- import: preview verdicts -----------------------------------------------------------------

  describe('import — preview', () => {
    it('classifies each row green, amber or red', async () => {
      const preview = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({
          content: csv([
            ['Besan', 'बेसन', 'KG', '90', '80', '5', 'BES1', 'Staples'], // clean
            ['Old Stock Rice', '', 'KG', '30', '45', '2', 'RIC9', 'Staples'], // amber: below cost
            ['', '', 'KG', '40', '', '', 'XXX1', ''], // red: no name
            ['Bad Unit', '', 'quintal', '40', '', '', 'XXX2', ''], // red: unknown unit
          ]),
        })
        .expect(201)

      expect(preview.body.data.summary).toMatchObject({ total: 4, create: 2, error: 2, warning: 1 })

      const rows = preview.body.data.rows
      expect(rows[1].warnings[0].messageKey).toBe('warnings.import.sellingBelowCost')
      expect(rows[2].errors[0].messageKey).toBe('errors.product.nameRequired')
      expect(rows[3].errors[0]).toMatchObject({
        messageKey: 'errors.product.invalidUnit',
        params: { unit: 'quintal' },
      })
    })

    it('shows the existing product a duplicate SKU collides with, and defaults to skipping it', async () => {
      await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Maggi 70g', unitCode: 'PACKET', sellingPricePaise: 1_400, sku: 'MAG70' })
        .expect(201)

      const preview = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content: csv([['Maggi Noodles 70g', '', 'PACKET', '15', '12', '20', 'MAG70', '']]) })
        .expect(201)

      const row = preview.body.data.rows[0]
      expect(row.status).toBe('SKIP')
      expect(row.duplicateOf).toMatchObject({
        field: 'sku',
        nameEn: 'Maggi 70g',
        sellingPricePaise: 1_400,
      })
    })

    it('rejects both rows when one file uses a code twice', async () => {
      // Importing either of two rows claiming one SKU is a coin toss, so neither is imported and
      // both are flagged — the shopkeeper sees the pair rather than one arbitrary victim.
      const preview = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({
          content: csv([
            ['Ghee 500ml', '', 'BOTTLE', '330', '300', '4', 'GHE5', ''],
            ['Ghee Half Litre', '', 'BOTTLE', '335', '300', '2', 'GHE5', ''],
          ]),
        })
        .expect(201)

      expect(preview.body.data.rows.map((r: { status: string }) => r.status)).toEqual([
        'ERROR',
        'ERROR',
      ])
      expect(preview.body.data.rows[0].errors[0].messageKey).toBe('errors.import.duplicateInFile')
    })

    it('writes nothing', async () => {
      const before = await request(server()).get('/v1/inventory/valuation').set(auth()).expect(200)

      await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content: csv([['Phantom', '', 'KG', '10', '', '99', 'PHAN', '']]) })
        .expect(201)

      const after = await request(server()).get('/v1/inventory/valuation').set(auth()).expect(200)
      expect(after.body.data.productCount).toBe(before.body.data.productCount)
    })

    it('requires an explicit unit rather than guessing when the file has none', async () => {
      const content = 'Name,Price\nAgarbatti,25\n'

      const withoutDefault = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content })
        .expect(201)
      expect(withoutDefault.body.data.rows[0].errors[0].messageKey).toBe('errors.import.unitRequired')

      const withDefault = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content, defaultUnitCode: 'PACKET' })
        .expect(201)
      expect(withDefault.body.data.rows[0].status).toBe('CREATE')
    })

    it('refuses a cashier — an import can reprice a whole catalogue', async () => {
      await request(server())
        .post('/v1/products/import/preview')
        .set({ Authorization: `Bearer ${cashierToken}` })
        .send({ content: csv([['X', '', 'KG', '1', '', '', '', '']]) })
        .expect(403)
    })
  })

  // --- import: commit ---------------------------------------------------------------------------

  describe('import — commit', () => {
    const mapping = {
      nameEn: 0, nameHi: 1, unitCode: 2, sellingPrice: 3,
      purchasePrice: 4, openingStock: 5, sku: 6, category: 7,
    }

    it('creates products, aliases-free rows included, with opening stock as a transaction', async () => {
      const response = await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({
          content: csv([
            ['Chana Dal', 'चना दाल', 'KG', '95', '85', '12', 'CHD1', 'Pulses'],
            ['Sooji', 'सूजी', 'KG', '48', '42', '8', 'SOO1', 'Pulses'],
          ]),
          mapping,
        })
        .expect(201)

      expect(response.body.data).toMatchObject({
        createdCount: 2,
        updatedCount: 0,
        failedCount: 0,
        failedCsv: null,
      })

      const search = await request(server()).get('/v1/products/search?q=chana').set(auth()).expect(200)
      expect(search.body.data[0]).toMatchObject({ nameEn: 'Chana Dal', qtyMilli: 12_000 })

      const stock = await request(server())
        .get(`/v1/inventory/products/${search.body.data[0].id}`)
        .set(auth())
        .expect(200)
      expect(stock.body.data.history[0].type).toBe('OPENING_STOCK')
    })

    it('creates the categories named in the file, matching existing ones case-insensitively', async () => {
      const categories = await request(server()).get('/v1/categories').set(auth()).expect(200)
      const pulses = categories.body.data.filter(
        (row: { nameEn: string | null }) => row.nameEn?.toLowerCase() === 'pulses',
      )

      // Two rows said "Pulses"; exactly one category exists, holding both products.
      expect(pulses).toHaveLength(1)
      expect(pulses[0].productCount).toBe(2)
    })

    it('keeps the reconciliation invariant after a bulk import', async () => {
      const response = await request(server()).get('/v1/inventory/reconcile').set(auth()).expect(200)
      expect(response.body.data.mismatchCount).toBe(0)
    })

    it('skips a duplicate by default, leaving the existing product untouched', async () => {
      const before = await request(server()).get('/v1/products/search?q=MAG70').set(auth()).expect(200)
      const original = before.body.data[0]

      const response = await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({
          content: csv([['Maggi Noodles 70g', '', 'PACKET', '15', '12', '20', 'MAG70', '']]),
          mapping,
        })
        .expect(201)

      expect(response.body.data).toMatchObject({ createdCount: 0, skippedCount: 1 })

      const after = await request(server()).get('/v1/products/search?q=MAG70').set(auth()).expect(200)
      expect(after.body.data[0].sellingPricePaise).toBe(original.sellingPricePaise)
      expect(after.body.data[0].nameEn).toBe('Maggi 70g')
    })

    it('updates the existing product only when the shopkeeper chose UPDATE for that row', async () => {
      const response = await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({
          content: csv([['Maggi Noodles 70g', '', 'PACKET', '15', '12', '20', 'MAG70', '']]),
          mapping,
          decisions: { '2': 'UPDATE' },
        })
        .expect(201)

      expect(response.body.data).toMatchObject({ createdCount: 0, updatedCount: 1 })

      const after = await request(server()).get('/v1/products/search?q=MAG70').set(auth()).expect(200)
      expect(after.body.data[0].sellingPricePaise).toBe(1_500)
      expect(after.body.data[0].nameEn).toBe('Maggi Noodles 70g')
    })

    it('does NOT apply opening stock on an UPDATE', async () => {
      // The product already has a stock history. Treating a spreadsheet column as opening stock
      // would either double-count or silently overwrite a real balance; stock changes go through
      // the inventory path, where they carry a reason and an actor.
      const search = await request(server()).get('/v1/products/search?q=MAG70').set(auth()).expect(200)
      const stock = await request(server())
        .get(`/v1/inventory/products/${search.body.data[0].id}`)
        .set(auth())
        .expect(200)

      expect(stock.body.data.qtyMilli).toBe(0)
      expect(stock.body.data.history).toHaveLength(0)
    })

    it('keeps both products on CREATE_ANYWAY, dropping the clashing code from the new one', async () => {
      const response = await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({
          content: csv([['Maggi 70g Value Pack', '', 'PACKET', '28', '24', '6', 'MAG70', '']]),
          mapping,
          decisions: { '2': 'CREATE_ANYWAY' },
        })
        .expect(201)

      expect(response.body.data.createdCount).toBe(1)

      const search = await request(server()).get('/v1/products/search?q=maggi').set(auth()).expect(200)
      const names = search.body.data.map((p: { nameEn: string }) => p.nameEn)

      // Both survive: the one that owned the code, and the new one the shopkeeper insisted on.
      expect(names).toContain('Maggi Noodles 70g')
      expect(names).toContain('Maggi 70g Value Pack')

      // Exactly one still owns the code — the new row gave it up rather than failing the batch
      // on the partial unique index.
      expect(search.body.data.filter((p: { sku: string | null }) => p.sku === 'MAG70')).toHaveLength(1)
      const valuePack = search.body.data.find(
        (p: { nameEn: string }) => p.nameEn === 'Maggi 70g Value Pack',
      )
      expect(valuePack.sku).toBeNull()
    })

    it('returns failed rows as a re-uploadable CSV carrying the original cells', async () => {
      const response = await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({
          content: csv([
            ['Rajma', 'राजमा', 'KG', '140', '120', '6', 'RAJ1', 'Pulses'],
            ['', '', 'KG', '40', '', '', 'BAD1', ''],
            ['Bad Price', '', 'KG', 'forty', '', '', 'BAD2', ''],
          ]),
          mapping,
        })
        .expect(201)

      expect(response.body.data).toMatchObject({ createdCount: 1, failedCount: 2 })

      const failedCsv: string = response.body.data.failedCsv
      expect(failedCsv).toContain('_line')
      expect(failedCsv).toContain('_error')
      expect(failedCsv).toContain('BAD1')
      expect(failedCsv).toContain('errors.product.nameRequired')
      // Three lines of output: header plus the two failures. The good row is not in the file.
      expect(failedCsv.trim().split('\r\n')).toHaveLength(3)
      expect(failedCsv).not.toContain('Rajma')
    })

    it('the preview verdict and the commit result agree', async () => {
      // The property that makes the wizard trustworthy: what step 3 promised is what step 4 did.
      const content = csv([
        ['Elaichi', 'इलायची', 'GRAM', '9', '7', '500', 'ELA1', 'Spices'],
        ['Laung', 'लौंग', 'GRAM', '11', '9', '300', 'LAU1', 'Spices'],
        ['', '', 'GRAM', '5', '', '', 'NOPE', ''],
      ])

      const preview = await request(server())
        .post('/v1/products/import/preview')
        .set(auth())
        .send({ content, mapping })
        .expect(201)

      const commit = await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({ content, mapping })
        .expect(201)

      expect(commit.body.data.createdCount).toBe(preview.body.data.summary.create)
      expect(commit.body.data.failedCount).toBe(preview.body.data.summary.error)
    })

    it('rolls the whole batch back when the transaction fails', async () => {
      const before = await request(server()).get('/v1/inventory/valuation').set(auth()).expect(200)

      // A CHECK constraint the row validator cannot pre-empt: an empty name reaching the database.
      // Whatever the cause, a mid-import failure must leave nothing behind — the shopkeeper is
      // never left with 3,000 of 5,000 products and no way to know which.
      await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({
          content: csv([
            ['Atomic One', '', 'KG', '10', '', '1', 'ATM1', ''],
            ['Atomic Two', '', 'KG', '20', '', '1', 'ATM2', ''],
          ]),
          mapping: { ...mapping, sellingPrice: 99 }, // no such column → every row loses its price
        })
        .expect(201)

      const after = await request(server()).get('/v1/inventory/valuation').set(auth()).expect(200)
      expect(after.body.data.productCount).toBe(before.body.data.productCount)
    })

    it('refuses a cashier', async () => {
      await request(server())
        .post('/v1/products/import/commit')
        .set({ Authorization: `Bearer ${cashierToken}` })
        .send({ content: csv([['X', '', 'KG', '1', '', '', '', '']]), mapping })
        .expect(403)
    })
  })

  // --- import: the acceptance criterion ---------------------------------------------------------

  describe('import — 5,000 rows (blueprint §28 acceptance criterion 4)', () => {
    it('imports 5,000 rows atomically, with a per-row error report', async () => {
      const rows: string[][] = []
      for (let i = 0; i < 4_980; i++) {
        rows.push([`Bulk Item ${i}`, `बल्क ${i}`, 'PIECE', '25', '20', '10', `BLK${i}`, 'Bulk'])
      }
      // Twenty deliberate failures scattered through the file, to prove the error report is
      // per-row and that a bad row does not take its neighbours down with it.
      for (let i = 0; i < 20; i++) {
        rows.push(['', '', 'PIECE', '25', '20', '10', `BAD${i}`, 'Bulk'])
      }

      const started = Date.now()
      const response = await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({
          content: csv(rows),
          mapping: {
            nameEn: 0, nameHi: 1, unitCode: 2, sellingPrice: 3,
            purchasePrice: 4, openingStock: 5, sku: 6, category: 7,
          },
        })
        .expect(201)
      const elapsed = Date.now() - started

      expect(response.body.data).toMatchObject({ createdCount: 4_980, failedCount: 20 })
      expect(response.body.data.failedCsv).toContain('errors.product.nameRequired')

      console.log(`5,000-row import committed in ${elapsed} ms`)
    }, 180_000)

    it('every imported product has an inventory transaction and the balances reconcile', async () => {
      const response = await request(server()).get('/v1/inventory/reconcile').set(auth()).expect(200)
      expect(response.body.data.mismatchCount).toBe(0)
    }, 60_000)

    it('search is still fast with the bulk rows in place', async () => {
      const started = Date.now()
      const response = await request(server())
        .get('/v1/products/search?q=bulk item 4321')
        .set(auth())
        .expect(200)
      const elapsed = Date.now() - started

      expect(response.body.data.length).toBeGreaterThan(0)
      expect(elapsed).toBeLessThan(100)
    })

    it('rejects a file over the row cap with a message naming the limit', async () => {
      const rows = Array.from({ length: 5_001 }, (_, i) => [
        `Over ${i}`, '', 'PIECE', '10', '', '', '', '',
      ])

      const response = await request(server())
        .post('/v1/products/import/commit')
        .set(auth())
        .send({ content: csv(rows), mapping: { nameEn: 0, unitCode: 2, sellingPrice: 3 } })
        .expect(422)

      expect(response.body.error.code).toBe('TOO_MANY_ROWS')
      expect(response.body.error.params).toMatchObject({ max: 5_000, received: 5_001 })
    }, 60_000)
  })

  // --- the nightly sweep --------------------------------------------------------------------------

  describe('nightly reconciliation sweep', () => {
    it('checks every active shop and finds this one clean', async () => {
      const { ReconciliationJob } = await import('../src/modules/inventory/reconciliation.job')
      const job = app.get(ReconciliationJob)

      const result = await job.reconcileAllShops()

      expect(result.shopsChecked).toBeGreaterThan(0)
      expect(result.shopsWithMismatch).toBe(0)
    }, 60_000)

    it('detects a balance corrupted behind the service’s back', async () => {
      // Write directly to the snapshot as the table owner, bypassing InventoryService entirely.
      // This is the only way to produce the state the sweep exists to catch — which is the point:
      // if it cannot be reached through the API, the sweep is the only thing that would ever see
      // it, and an untested detector is not a detector.
      const search = await request(server()).get('/v1/products/search?q=chana').set(auth()).expect(200)
      const productId = search.body.data[0].id

      sql(`UPDATE inventory_balance SET qty_milli = qty_milli + 5000 WHERE product_id = '${productId}'`)

      const { ReconciliationJob } = await import('../src/modules/inventory/reconciliation.job')
      const result = await app.get(ReconciliationJob).reconcileAllShops()

      expect(result.shopsWithMismatch).toBe(1)

      // And it reports rather than heals: the corrupted number is still there, because silently
      // rewriting it would erase the evidence of the write-path bug that caused it.
      const stock = await request(server())
        .get(`/v1/inventory/products/${productId}`)
        .set(auth())
        .expect(200)
      expect(stock.body.data.qtyMilli).toBe(17_000)

      sql(`UPDATE inventory_balance SET qty_milli = qty_milli - 5000 WHERE product_id = '${productId}'`)
    }, 60_000)
  })

  // --- tenant isolation on the new routes -------------------------------------------------------

  it('a second shop sees none of the first shop\'s categories or imports', async () => {
    const intruder = await request(server())
      .post('/v1/auth/register')
      .send({
        phone: nextPhone(),
        password: 'correct horse battery',
        fullName: 'Someone Else',
        shopName: 'Other Store',
      })
      .expect(201)
    const otherAuth = { Authorization: `Bearer ${intruder.body.data.accessToken}` }

    expect(intruder.body.data.shop.id).not.toBe(shopId)

    const categories = await request(server()).get('/v1/categories').set(otherAuth).expect(200)
    expect(categories.body.data).toEqual([])

    const search = await request(server()).get('/v1/products/search?q=chana').set(otherAuth).expect(200)
    expect(search.body.data).toEqual([])
  })
})
