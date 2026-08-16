import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { execSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { createTestApp, nextPhone, prepareTestDatabase, truncateAll } from './harness'

/**
 * Phase 3 — the sync engine (blueprint §14).
 *
 * Acceptance criteria under test (§28):
 *   1. the lost-change test passes (§14.5)
 *   2. a duplicate `op_id` is a no-op
 *   3. a 45-day-stale device is forced to bootstrap
 *   4. 500 queued ops sync correctly
 */
describe('sync engine', () => {
  let app: INestApplication
  let token = ''
  let shopId = ''
  let deviceId = ''
  let productId = ''

  const auth = () => ({ Authorization: `Bearer ${token}` })
  const server = () => app.getHttpServer()

  const push = (ops: unknown[], device = deviceId) =>
    request(server()).post('/v1/sync/push').set(auth()).send({ deviceId: device, ops })

  const pull = (cursor?: string, limit = 200) =>
    request(server())
      .get('/v1/sync/pull')
      .query({ deviceId, limit, ...(cursor ? { cursor } : {}) })
      .set(auth())

  const productOp = (overrides: Record<string, unknown> = {}) => ({
    opId: randomUUID(),
    entity: 'product',
    entityId: randomUUID(),
    opType: 'create',
    clientUpdatedAt: new Date().toISOString(),
    payload: { nameEn: 'Queued Item', unitCode: 'PIECE', sellingPricePaise: 1_000 },
    ...overrides,
  })

  const sql = (statement: string) =>
    execSync(
      `docker exec dukaano-postgres psql -U dukaano -d dukaano_test -qtAc ${JSON.stringify(statement)}`,
      { stdio: 'pipe', shell: '/bin/bash' },
    )
      .toString()
      .trim()

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

    const device = await request(server())
      .post('/v1/sync/devices')
      .set(auth())
      .send({ platform: 'ANDROID', name: 'Counter phone', appVersion: '1.4.0' })
      .expect(201)
    deviceId = device.body.data.id

    const product = await request(server())
      .post('/v1/products')
      .set(auth())
      .send({ nameEn: 'Sugar Loose', nameHi: 'चीनी', unitCode: 'KG', sellingPricePaise: 4_450 })
      .expect(201)
    productId = product.body.data.id

    // A device with no cursor is told to bootstrap, which is correct and is asserted separately.
    // Everything below tests delta behaviour, so this device starts where a real one would after
    // its first login.
    await request(server()).get('/v1/sync/bootstrap').query({ deviceId }).set(auth()).expect(200)
  }, 120_000)

  afterAll(async () => {
    await app?.close()
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // The change log — the feed everything else depends on
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('change log', () => {
    it('records a row in the same transaction as the write', async () => {
      const before = Number(sql(`SELECT count(*) FROM change_log WHERE shop_id = '${shopId}'`))

      await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Logged Product', unitCode: 'PIECE', sellingPricePaise: 500 })
        .expect(201)

      const after = Number(sql(`SELECT count(*) FROM change_log WHERE shop_id = '${shopId}'`))
      expect(after).toBeGreaterThan(before)
    })

    it('stamps txid from the database, not the application', async () => {
      // pg_current_xact_id() is the transaction's real id. Anything application-supplied could be
      // wrong in exactly the way that breaks the cursor.
      const txid = sql(
        `SELECT txid::text FROM change_log WHERE shop_id = '${shopId}' ORDER BY id DESC LIMIT 1`,
      )
      expect(txid).toMatch(/^\d+$/)
      expect(BigInt(txid)).toBeGreaterThan(0n)
    })

    it('rolls back with the write it accompanies', async () => {
      const before = Number(sql(`SELECT count(*) FROM change_log WHERE shop_id = '${shopId}'`))

      // A product with no name violates a CHECK constraint, so the request's transaction — and
      // any change row inside it — rolls back together.
      await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ unitCode: 'PIECE', sellingPricePaise: 500 })
        .expect(400)

      expect(Number(sql(`SELECT count(*) FROM change_log WHERE shop_id = '${shopId}'`))).toBe(before)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Criterion 1 — the lost-change test
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('the lost-change test (§14.5, acceptance criterion 1)', () => {
    it('never serves a change whose id was allocated before an in-flight transaction', async () => {
      /*
       * This reproduces the exact bug the xmin cursor exists to prevent, and it is the single most
       * important test in the suite.
       *
       * `change_log.id` is BIGSERIAL: allocated at INSERT, visible at COMMIT. So:
       *
       *   session A: INSERT (takes id 100) … stays open
       *   session B: INSERT (takes id 105) … COMMITS
       *   a cursor keyed on `id` now serves 105, advances past it, and when A finally commits,
       *   row 100 is behind the cursor forever. The sale silently never reaches the device.
       *
       * The setup below holds a real uncommitted transaction open in one connection while the
       * device pulls in another, then commits it and pulls again. The row written by the slow
       * transaction MUST arrive.
       */
      const slowProductId = randomUUID()
      const fastProductId = randomUUID()

      // Session A: insert, then sit on the open transaction. Spawned rather than exec'd so the
      // test continues while it holds; `docker exec -d` cannot be combined with a container name.
      const holder = spawn(
        'docker',
        [
          'exec', '-i', 'dukaano-postgres',
          'psql', '-U', 'dukaano', '-d', 'dukaano_test', '-c',
          `BEGIN; INSERT INTO change_log (shop_id, entity, entity_id, op, row_version) ` +
            `VALUES ('${shopId}', 'product', '${slowProductId}', 'upsert', 1); ` +
            `SELECT pg_sleep(4); COMMIT;`,
        ],
        { stdio: 'ignore' },
      )

      // Let session A take its id and begin sleeping.
      await new Promise((resolve) => setTimeout(resolve, 800))

      // Session B: insert and commit immediately. This gets a HIGHER id than the open one.
      sql(
        `INSERT INTO change_log (shop_id, entity, entity_id, op, row_version) ` +
          `VALUES ('${shopId}', 'product', '${fastProductId}', 'upsert', 1)`,
      )

      // Pull while A is still open. An id-based cursor would serve the fast row here and advance
      // past the slow one. The xmin watermark must serve NEITHER, because both sit at or above
      // pg_snapshot_xmin while A is in flight.
      const during = await pull().expect(200)
      const seenDuring = during.body.data.changes.map((c: { entityId: string }) => c.entityId)

      expect(seenDuring).not.toContain(slowProductId)
      expect(
        seenDuring,
        'the fast row was served while an older transaction was still in flight — the cursor ' +
          'would advance past the slow row and lose it permanently',
      ).not.toContain(fastProductId)

      // Wait for A to commit.
      await new Promise<void>((resolve) => {
        holder.on('exit', () => resolve())
        setTimeout(resolve, 8_000)
      })

      // Now both must arrive on the very next pull, using the cursor the device was given.
      const after = await pull(during.body.data.cursor).expect(200)
      const seenAfter = after.body.data.changes.map((c: { entityId: string }) => c.entityId)

      expect(seenAfter).toContain(slowProductId)
      expect(seenAfter).toContain(fastProductId)
    }, 60_000)

    it('advances the cursor only past transactions that have all finished', async () => {
      const txidOf = (cursor: string) => BigInt(cursor.split(':')[0] as string)

      const first = await pull().expect(200)
      const second = await pull(first.body.data.cursor).expect(200)

      // Monotonic: a cursor never goes backwards, or the device re-downloads forever.
      expect(txidOf(second.body.data.cursor)).toBeGreaterThanOrEqual(txidOf(first.body.data.cursor))
    })

    it('re-serving a change is harmless because the apply key is (entity, id, rowVersion)', async () => {
      const cursor = (await pull().expect(200)).body.data.cursor

      await request(server())
        .patch(`/v1/products/${productId}`)
        .set(auth())
        .send({ sellingPricePaise: 4_600 })
        .expect(200)

      // Pulling twice from the same cursor returns the same change both times. The client upserts,
      // so overlap costs nothing — which is what lets the watermark be inclusive at its lower edge.
      const a = await pull(cursor).expect(200)
      const b = await pull(cursor).expect(200)

      const inA = a.body.data.changes.filter((c: { entityId: string }) => c.entityId === productId)
      const inB = b.body.data.changes.filter((c: { entityId: string }) => c.entityId === productId)

      expect(inA.length).toBeGreaterThan(0)
      expect(inB.map((c: { rowVersion: number }) => c.rowVersion)).toEqual(
        inA.map((c: { rowVersion: number }) => c.rowVersion),
      )
    })

    it('drains a backlog larger than one page instead of re-serving it forever', async () => {
      /*
       * The regression this guards. An earlier version left the cursor unchanged whenever a page
       * was truncated, reasoning that advancing to the current watermark would skip the remainder.
       * Both are wrong: the client then received the same two rows on every pull and a device with
       * a backlog could never catch up. The cursor is a keyset on (txid, id), so it advances to
       * exactly the last row delivered.
       */
      const cursor = (await pull().expect(200)).body.data.cursor
      const created: string[] = []

      for (let i = 0; i < 5; i++) {
        const product = await request(server())
          .post('/v1/products')
          .set(auth())
          .send({ nameEn: `Paged ${i}`, unitCode: 'PIECE', sellingPricePaise: 100 })
          .expect(201)
        created.push(product.body.data.id)
      }

      const page = await pull(cursor, 2).expect(200)
      expect(page.body.data.hasMore).toBe(true)
      expect(page.body.data.changes).toHaveLength(2)
      // It moved. A cursor that did not would loop forever.
      expect(page.body.data.cursor).not.toBe(cursor)

      const seen = new Set<string>(page.body.data.changes.map((c: { entityId: string }) => c.entityId))
      let next = page.body.data.cursor
      let pages = 1

      while (pages < 30) {
        const response = await pull(next, 2).expect(200)
        for (const change of response.body.data.changes) seen.add(change.entityId)
        expect(response.body.data.cursor).not.toBe(next)
        next = response.body.data.cursor
        pages++
        if (!response.body.data.hasMore) break
      }

      // Every product reached the device, and it took a bounded number of pages.
      for (const id of created) expect(seen).toContain(id)
      expect(pages).toBeLessThan(30)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Criterion 2 — idempotency
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('duplicate op_id is a no-op (acceptance criterion 2)', () => {
    it('applies an op once and reports the replay as a duplicate', async () => {
      const op = productOp({ payload: { nameEn: 'Idempotent Item', unitCode: 'PIECE', sellingPricePaise: 2_500 } })

      const first = await push([op]).expect(201)
      expect(first.body.data.results[0].status).toBe('applied')

      const second = await push([op]).expect(201)
      expect(second.body.data.results[0].status).toBe('duplicate')

      // One product, not two. This is the duplicate-sale defence in miniature.
      const count = Number(
        sql(`SELECT count(*) FROM product WHERE shop_id = '${shopId}' AND name_en = 'Idempotent Item'`),
      )
      expect(count).toBe(1)
    })

    it('returns the stored original result on replay, not a freshly derived one', async () => {
      const op = productOp({ payload: { nameEn: 'Stored Result', unitCode: 'PIECE', sellingPricePaise: 700 } })

      const first = await push([op]).expect(201)
      const replay = await push([op]).expect(201)

      expect(replay.body.data.results[0].rowVersion).toBe(first.body.data.results[0].rowVersion)
    })

    it('survives the whole batch being retried', async () => {
      // The realistic case: the response was lost, so the client resends everything it queued.
      const ops = Array.from({ length: 5 }, (_, i) =>
        productOp({ payload: { nameEn: `Batch Retry ${i}`, unitCode: 'PIECE', sellingPricePaise: 100 } }),
      )

      const first = await push(ops).expect(201)
      expect(first.body.data.results.every((r: { status: string }) => r.status === 'applied')).toBe(true)

      const retry = await push(ops).expect(201)
      expect(retry.body.data.results.every((r: { status: string }) => r.status === 'duplicate')).toBe(true)

      const count = Number(
        sql(`SELECT count(*) FROM product WHERE shop_id = '${shopId}' AND name_en LIKE 'Batch Retry %'`),
      )
      expect(count).toBe(5)
    })

    it('rejects a batch that repeats an op id within itself', async () => {
      // Not deduplicated — rejected. Two ops sharing an id means the client's outbox is generating
      // colliding keys, and the entire duplicate defence rests on those being unique.
      const op = productOp()
      const response = await push([op, { ...op, entityId: randomUUID() }]).expect(400)
      expect(JSON.stringify(response.body)).toContain('errors.sync.duplicateOpIdInBatch')
    })

    it('treats a create replayed with the same entity id as already applied', async () => {
      // A create whose response was lost arrives again under a *new* op id — the client rebuilt
      // its outbox — but the same client-generated entity id. It must not make a second product.
      const entityId = randomUUID()
      await push([productOp({ entityId, payload: { nameEn: 'Same Entity', unitCode: 'PIECE', sellingPricePaise: 300 } })]).expect(201)
      const again = await push([
        productOp({ entityId, payload: { nameEn: 'Same Entity', unitCode: 'PIECE', sellingPricePaise: 300 } }),
      ]).expect(201)

      expect(again.body.data.results[0].status).toBe('applied')
      expect(
        Number(sql(`SELECT count(*) FROM product WHERE shop_id = '${shopId}' AND id = '${entityId}'`)),
      ).toBe(1)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Criterion 3 — the stale device
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('a stale device must bootstrap (acceptance criterion 3)', () => {
    it('forces a bootstrap for a device that has never pulled', async () => {
      const fresh = await request(server())
        .post('/v1/sync/devices')
        .set(auth())
        .send({ platform: 'IOS', name: 'New iPad' })
        .expect(201)

      const response = await request(server())
        .get('/v1/sync/pull')
        .query({ deviceId: fresh.body.data.id })
        .set(auth())
        .expect(200)

      expect(response.body.data).toMatchObject({ snapshotRequired: true, reason: 'NO_CURSOR' })
    })

    it('forces a bootstrap for a 45-day-stale device', async () => {
      const stale = await request(server())
        .post('/v1/sync/devices')
        .set(auth())
        .send({ platform: 'ANDROID', name: 'Phone in a drawer' })
        .expect(201)
      const staleId = stale.body.data.id

      await request(server()).get('/v1/sync/bootstrap').query({ deviceId: staleId }).set(auth()).expect(200)

      // Age it past the 30-day change-log retention window.
      sql(
        `UPDATE device SET last_pulled_at = now() - interval '45 days' WHERE id = '${staleId}'`,
      )

      const response = await request(server())
        .get('/v1/sync/pull')
        .query({ deviceId: staleId })
        .set(auth())
        .expect(200)

      expect(response.body.data).toMatchObject({ snapshotRequired: true, reason: 'CURSOR_EXPIRED' })
    })

    it('still serves a delta to a device that pulled a week ago', async () => {
      sql(`UPDATE device SET last_pulled_at = now() - interval '7 days' WHERE id = '${deviceId}'`)

      const response = await pull().expect(200)
      expect(response.body.data.snapshotRequired).toBe(false)
    })

    it('bootstrap returns the whole dataset with a usable cursor', async () => {
      const response = await request(server())
        .get('/v1/sync/bootstrap')
        .query({ deviceId })
        .set(auth())
        .expect(200)

      expect(response.body.data.products.length).toBeGreaterThan(0)
      // Composite `<txid>:<changeId>`, with changeId 0 so the first delta is inclusive of any
      // transaction that was still in flight when the snapshot was taken.
      expect(response.body.data.cursor).toMatch(/^\d+:0$/)
      // Derived state is included so the device never has to compute a balance itself (§14.7).
      expect(response.body.data).toHaveProperty('inventoryBalances')
      expect(response.body.data).toHaveProperty('productAliases')
    })

    it('a delta straight after bootstrap returns only what changed since', async () => {
      const boot = await request(server())
        .get('/v1/sync/bootstrap')
        .query({ deviceId })
        .set(auth())
        .expect(200)

      const quiet = await pull(boot.body.data.cursor).expect(200)
      expect(quiet.body.data.changes).toHaveLength(0)

      await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'After Bootstrap', unitCode: 'PIECE', sellingPricePaise: 900 })
        .expect(201)

      const delta = await pull(boot.body.data.cursor).expect(200)
      expect(delta.body.data.changes.length).toBeGreaterThan(0)
    })

    it('refuses to sync a revoked device', async () => {
      const doomed = await request(server())
        .post('/v1/sync/devices')
        .set(auth())
        .send({ platform: 'ANDROID', name: 'Lost phone' })
        .expect(201)

      await request(server()).delete(`/v1/sync/devices/${doomed.body.data.id}`).set(auth()).expect(200)

      const response = await request(server())
        .get('/v1/sync/pull')
        .query({ deviceId: doomed.body.data.id })
        .set(auth())
        .expect(422)
      expect(response.body.error.code).toBe('DEVICE_REVOKED')
    })

    it('will not let a revoked device re-register itself', async () => {
      // Otherwise revocation means nothing: the stolen phone simply clears the flag.
      const doomed = await request(server())
        .post('/v1/sync/devices')
        .set(auth())
        .send({ platform: 'ANDROID', name: 'Stolen' })
        .expect(201)
      await request(server()).delete(`/v1/sync/devices/${doomed.body.data.id}`).set(auth()).expect(200)

      const response = await request(server())
        .post('/v1/sync/devices')
        .set(auth())
        .send({ deviceId: doomed.body.data.id, platform: 'ANDROID', name: 'Stolen' })
        .expect(422)
      expect(response.body.error.code).toBe('DEVICE_REVOKED')
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Criterion 4 — volume
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('500 queued ops sync correctly (acceptance criterion 4)', () => {
    it('applies a fortnight of queued work across batches, then replays as duplicates', async () => {
      const all = Array.from({ length: 500 }, (_, i) =>
        productOp({
          payload: { nameEn: `Queued ${i}`, unitCode: 'PIECE', sellingPricePaise: 100 + i },
        }),
      )

      // The client flushes in batches of 100 — the server's cap — exactly as the app will.
      const started = Date.now()
      for (let i = 0; i < all.length; i += 100) {
        const response = await push(all.slice(i, i + 100)).expect(201)
        expect(response.body.data.results).toHaveLength(100)
        expect(
          response.body.data.results.filter((r: { status: string }) => r.status === 'applied'),
        ).toHaveLength(100)
      }
      const elapsed = Date.now() - started

      expect(
        Number(sql(`SELECT count(*) FROM product WHERE shop_id = '${shopId}' AND name_en LIKE 'Queued %'`)),
      ).toBe(500)

      console.log(`500 queued ops applied in ${elapsed} ms`)

      // Replaying the whole queue creates nothing.
      const replay = await push(all.slice(0, 100)).expect(201)
      expect(
        replay.body.data.results.every((r: { status: string }) => r.status === 'duplicate'),
      ).toBe(true)
      expect(
        Number(sql(`SELECT count(*) FROM product WHERE shop_id = '${shopId}' AND name_en LIKE 'Queued %'`)),
      ).toBe(500)
    }, 180_000)

    it('every applied op produced a change-log row, so all 500 reach other devices', async () => {
      const products = Number(
        sql(`SELECT count(*) FROM product WHERE shop_id = '${shopId}' AND name_en LIKE 'Queued %'`),
      )
      const logged = Number(
        sql(
          `SELECT count(DISTINCT c.entity_id) FROM change_log c ` +
            `JOIN product p ON p.id = c.entity_id ` +
            `WHERE c.shop_id = '${shopId}' AND p.name_en LIKE 'Queued %'`,
        ),
      )
      expect(logged).toBe(products)
    })

    it('rejects a batch larger than the cap rather than accepting it slowly', async () => {
      const response = await push(Array.from({ length: 101 }, () => productOp())).expect(400)
      expect(JSON.stringify(response.body)).toContain('errors.sync.batchTooLarge')
    })

    it('one bad op does not roll back the rest of the batch', async () => {
      /*
       * The property that makes push non-atomic worth its complexity. A batch holds a fortnight of
       * unrelated work; if one poisonous op rolled back the other 499, the client would retry the
       * same batch forever, making no progress, with no way to identify the culprit.
       */
      const good1 = productOp({ payload: { nameEn: 'Good One', unitCode: 'PIECE', sellingPricePaise: 100 } })
      const bad = productOp({ payload: { unitCode: 'PIECE', sellingPricePaise: 100 } }) // no name
      const good2 = productOp({ payload: { nameEn: 'Good Two', unitCode: 'PIECE', sellingPricePaise: 100 } })

      const response = await push([good1, bad, good2]).expect(201)
      const statuses = response.body.data.results.map((r: { status: string }) => r.status)

      expect(statuses[0]).toBe('applied')
      expect(statuses[1]).not.toBe('applied')
      expect(statuses[2]).toBe('applied')

      expect(
        Number(sql(`SELECT count(*) FROM product WHERE shop_id = '${shopId}' AND name_en IN ('Good One','Good Two')`)),
      ).toBe(2)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Conflict policy (§14.7)
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('conflict policy', () => {
    let conflictProductId = ''

    beforeAll(async () => {
      const product = await request(server())
        .post('/v1/products')
        .set(auth())
        .send({ nameEn: 'Conflict Subject', unitCode: 'KG', sellingPricePaise: 5_000 })
        .expect(201)
      conflictProductId = product.body.data.id
    })

    it('accepts a newer edit made against the current row version', async () => {
      const current = await request(server())
        .get(`/v1/products/${conflictProductId}`)
        .set(auth())
        .expect(200)

      const response = await push([
        productOp({
          entityId: conflictProductId,
          opType: 'update',
          baseVersion: current.body.data.rowVersion,
          clientUpdatedAt: new Date().toISOString(),
          payload: { sellingPricePaise: 5_500 },
        }),
      ]).expect(201)

      expect(response.body.data.results[0].status).toBe('applied')

      const after = await request(server()).get(`/v1/products/${conflictProductId}`).set(auth()).expect(200)
      expect(after.body.data.sellingPricePaise).toBe(5_500)
    })

    it('refuses a price edit made against a stale row version, and keeps the shop price', async () => {
      // The phone in a drawer: its price predates a supplier increase it never saw.
      const response = await push([
        productOp({
          entityId: conflictProductId,
          opType: 'update',
          baseVersion: 1,
          clientUpdatedAt: new Date(Date.now() + 60_000).toISOString(),
          payload: { sellingPricePaise: 4_000 },
        }),
      ]).expect(201)

      expect(response.body.data.results[0]).toMatchObject({
        status: 'conflict',
        resolution: 'server_wins',
      })

      const after = await request(server()).get(`/v1/products/${conflictProductId}`).set(auth()).expect(200)
      expect(after.body.data.sellingPricePaise).toBe(5_500)
    })

    it('keeps the safe half of a patch that also carries a stale price', async () => {
      const response = await push([
        productOp({
          entityId: conflictProductId,
          opType: 'update',
          baseVersion: 1,
          clientUpdatedAt: new Date(Date.now() + 120_000).toISOString(),
          payload: { nameEn: 'Conflict Subject Renamed', sellingPricePaise: 3_000 },
        }),
      ]).expect(201)

      expect(response.body.data.results[0].resolution).toBe('partial')

      const after = await request(server()).get(`/v1/products/${conflictProductId}`).set(auth()).expect(200)
      // The rename landed; the stale price did not.
      expect(after.body.data.nameEn).toBe('Conflict Subject Renamed')
      expect(after.body.data.sellingPricePaise).toBe(5_500)
    })

    it('records every refusal in the conflict inbox — nothing is discarded silently', async () => {
      const response = await request(server()).get('/v1/sync/conflicts').set(auth()).expect(200)

      const forProduct = response.body.data.filter(
        (c: { entityId: string }) => c.entityId === conflictProductId,
      )
      expect(forProduct.length).toBeGreaterThanOrEqual(2)
      expect(forProduct[0]).toHaveProperty('clientPayload')
      expect(forProduct[0]).toHaveProperty('serverPayload')
    })

    it('acknowledging is idempotent and hides the entry from the inbox', async () => {
      const inbox = await request(server()).get('/v1/sync/conflicts').set(auth()).expect(200)
      const target = inbox.body.data[0]

      const first = await request(server())
        .post(`/v1/sync/conflicts/${target.id}/acknowledge`)
        .set(auth())
        .expect(201)
      const second = await request(server())
        .post(`/v1/sync/conflicts/${target.id}/acknowledge`)
        .set(auth())
        .expect(201)

      // The second tap is a double-tap on a phone, not a second decision.
      expect(second.body.data.acknowledgedAt).toBe(first.body.data.acknowledgedAt)

      const after = await request(server()).get('/v1/sync/conflicts').set(auth()).expect(200)
      expect(after.body.data.map((c: { id: string }) => c.id)).not.toContain(target.id)
    })

    it('refuses a client attempt to set archive status', async () => {
      const current = await request(server())
        .get(`/v1/products/${conflictProductId}`)
        .set(auth())
        .expect(200)

      const response = await push([
        productOp({
          entityId: conflictProductId,
          opType: 'update',
          baseVersion: current.body.data.rowVersion,
          clientUpdatedAt: new Date(Date.now() + 200_000).toISOString(),
          payload: { archivedAt: new Date().toISOString() },
        }),
      ]).expect(201)

      expect(response.body.data.results[0].rejectedFields[0]).toMatchObject({
        field: 'archivedAt',
        reason: 'SERVER_AUTHORITATIVE',
      })

      const after = await request(server()).get(`/v1/products/${conflictProductId}`).set(auth()).expect(200)
      expect(after.body.data.archivedAt).toBeNull()
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Invoice number leases (§14.6)
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('invoice number leases', () => {
    it('issues a block a device can draw from offline', async () => {
      const response = await request(server())
        .post('/v1/sync/number-lease')
        .set(auth())
        .send({ deviceId, size: 200 })
        .expect(201)

      expect(response.body.data.rangeTo - response.body.data.rangeFrom).toBe(199)
      expect(response.body.data.nextValue).toBe(response.body.data.rangeFrom)
    })

    it('never issues overlapping ranges to two devices', async () => {
      // Two customers holding receipts with the same invoice number is worse than any gap.
      const second = await request(server())
        .post('/v1/sync/devices')
        .set(auth())
        .send({ platform: 'ANDROID', name: 'Second counter' })
        .expect(201)

      const [a, b] = await Promise.all([
        request(server()).post('/v1/sync/number-lease').set(auth()).send({ deviceId, size: 100 }),
        request(server())
          .post('/v1/sync/number-lease')
          .set(auth())
          .send({ deviceId: second.body.data.id, size: 100 }),
      ])

      const ranges = [a.body.data, b.body.data].sort((x, y) => x.rangeFrom - y.rangeFrom)
      expect(ranges[0].rangeTo).toBeLessThan(ranges[1].rangeFrom)
    })

    it('survives concurrent lease requests without a collision', async () => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(server()).post('/v1/sync/number-lease').set(auth()).send({ deviceId, size: 50 }),
        ),
      )

      expect(responses.every((r) => r.status === 201)).toBe(true)

      const ranges = responses
        .map((r) => r.body.data)
        .sort((x, y) => x.rangeFrom - y.rangeFrom)
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i].rangeFrom).toBeGreaterThan(ranges[i - 1].rangeTo)
      }
    })

    it('retires the previous lease so a device cannot keep drawing from it', async () => {
      const live = Number(
        sql(
          `SELECT count(*) FROM number_lease WHERE shop_id = '${shopId}' ` +
            `AND device_id = '${deviceId}' AND exhausted_at IS NULL`,
        ),
      )
      expect(live).toBe(1)
    })

    it('returns the live lease so a reinstalled app resumes instead of re-leasing', async () => {
      const response = await request(server())
        .get('/v1/sync/number-lease')
        .query({ deviceId })
        .set(auth())
        .expect(200)

      expect(response.body.data).not.toBeNull()
      expect(response.body.data.series).toBe('INV')
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Device registry and clock skew (E-26)
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('device registry', () => {
    it('re-registering an existing device keeps its identity and its cursor', async () => {
      const before = sql(`SELECT last_sync_xmin FROM device WHERE id = '${deviceId}'`)

      const response = await request(server())
        .post('/v1/sync/devices')
        .set(auth())
        .send({ deviceId, platform: 'ANDROID', name: 'Counter phone', appVersion: '1.5.0' })
        .expect(201)

      expect(response.body.data.id).toBe(deviceId)
      expect(sql(`SELECT last_sync_xmin FROM device WHERE id = '${deviceId}'`)).toBe(before)
    })

    it('records a skewed device clock rather than trusting or rejecting it (E-26)', async () => {
      await request(server())
        .post('/v1/sync/push')
        .set(auth())
        .send({
          deviceId,
          clientTime: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
          ops: [productOp({ payload: { nameEn: 'Skewed Clock', unitCode: 'PIECE', sellingPricePaise: 100 } })],
        })
        .expect(201)

      const skew = Number(sql(`SELECT clock_skew_ms FROM device WHERE id = '${deviceId}'`))
      // Roughly three days. Stored so "why is this sale dated yesterday?" stays answerable.
      expect(skew).toBeGreaterThan(2 * 24 * 60 * 60 * 1000)

      // The op still applied — a wrong clock is not a reason to refuse a real transaction.
      expect(
        Number(sql(`SELECT count(*) FROM product WHERE shop_id = '${shopId}' AND name_en = 'Skewed Clock'`)),
      ).toBe(1)
    })

    it('lists devices for an owner but not for a cashier', async () => {
      await request(server()).get('/v1/sync/devices').set(auth()).expect(200)

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

      await request(server())
        .get('/v1/sync/devices')
        .set({ Authorization: `Bearer ${login.body.data.accessToken}` })
        .expect(403)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // Retention
  // ═════════════════════════════════════════════════════════════════════════════════════════════

  describe('retention', () => {
    it('prunes change-log rows past 30 days but keeps processed operations to 90', async () => {
      const opId = randomUUID()
      sql(
        `INSERT INTO change_log (shop_id, entity, entity_id, op, row_version, changed_at) ` +
          `VALUES ('${shopId}', 'product', '${randomUUID()}', 'upsert', 1, now() - interval '40 days')`,
      )
      sql(
        `INSERT INTO processed_operation (op_id, shop_id, entity, op_type, status, created_at) ` +
          `VALUES ('${opId}', '${shopId}', 'product', 'create', 'applied', now() - interval '40 days')`,
      )

      const { SyncRetentionJob } = await import('../src/modules/sync/sync-retention.job')
      const result = await app.get(SyncRetentionJob).prune()

      expect(result.changeLogDeleted).toBeGreaterThan(0)
      // Deliberately longer: a device forced to bootstrap at 30 days may still hold un-pushed ops,
      // and those must stay replay-safe when they finally arrive.
      expect(Number(sql(`SELECT count(*) FROM processed_operation WHERE op_id = '${opId}'`))).toBe(1)
    })
  })
})
