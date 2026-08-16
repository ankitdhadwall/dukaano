import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { createTestApp, nextPhone, prepareTestDatabase, truncateAll } from './harness'
import { enumerateRoutes } from './route-table'

/**
 * THE tenant-isolation suite (blueprint §13, §23.3, §26.3).
 *
 * A cross-tenant leak of khata data would end this business — a shopkeeper's customer list and
 * outstanding balances are the most commercially sensitive data they have, and the first time
 * one shop sees another's is the last day anyone in that town trusts Dukaano.
 *
 * So this suite is **generated from the route table** rather than hand-written per endpoint. A
 * new controller route that forgets tenancy is picked up automatically and fails CI; it cannot
 * be missed by a reviewer who did not think to add a test for it.
 *
 * Two shops are created through the real registration flow. Shop A then attacks Shop B by every
 * route the API exposes, using Shop B's real resource ids.
 */
describe('tenant isolation', () => {
  let app: INestApplication
  type Shop = { token: string; shopId: string; membershipId: string; productId: string }
  let shopA: Shop
  let shopB: Shop

  const register = async (shopName: string) => {
    const phone = nextPhone()
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ phone, password: 'correct horse battery', fullName: 'Owner', shopName })
      .expect(201)

    const token = res.body.data.accessToken as string
    const shopId = res.body.data.shop.id as string

    const me = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    // Every shop gets a product, so the catalogue and inventory routes have a real foreign id
    // to be attacked with.
    const product = await request(app.getHttpServer())
      .post('/v1/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nameEn: `${shopName} Sugar`,
        unitCode: 'KG',
        sellingPricePaise: 5000,
        openingStockMilli: 10_000,
      })
      .expect(201)

    return {
      token,
      shopId,
      membershipId: me.body.data.membershipId as string,
      productId: product.body.data.id as string,
    }
  }

  beforeAll(async () => {
    prepareTestDatabase()
    truncateAll()
    app = await createTestApp()
    shopA = await register('Sharma General Store')
    shopB = await register('Gupta Kirana')
  }, 120_000)

  afterAll(async () => {
    await app?.close()
  })

  it('creates two genuinely distinct shops', () => {
    expect(shopA.shopId).not.toBe(shopB.shopId)
  })

  describe('each shop sees only its own data', () => {
    it('returns the correct shop for each token', async () => {
      const a = await request(app.getHttpServer())
        .get('/v1/shops/current')
        .set('Authorization', `Bearer ${shopA.token}`)
        .expect(200)
      expect(a.body.data.name).toBe('Sharma General Store')

      const b = await request(app.getHttpServer())
        .get('/v1/shops/current')
        .set('Authorization', `Bearer ${shopB.token}`)
        .expect(200)
      expect(b.body.data.name).toBe('Gupta Kirana')
    })

    it('lists only its own staff', async () => {
      const a = await request(app.getHttpServer())
        .get('/v1/memberships')
        .set('Authorization', `Bearer ${shopA.token}`)
        .expect(200)
      expect(a.body.data).toHaveLength(1)
      expect(a.body.data[0].id).toBe(shopA.membershipId)
    })
  })

  /**
   * The attack matrix.
   *
   * Every route that accepts a resource id is called by Shop A with one of Shop B's real ids.
   * Adding a route to this table is the only work required to cover a new endpoint — and the
   * `route coverage` test below fails if a controller route exists that is not represented here.
   */
  const attacks: {
    name: string
    method: 'get' | 'patch' | 'post' | 'delete'
    path: (victim: Shop) => string
    body?: unknown
  }[] = [
    {
      name: 'GET /v1/shops/:id with the victim shop id',
      method: 'get',
      path: (victim) => `/v1/shops/${victim.shopId}`,
    },
    {
      name: 'PATCH /v1/memberships/:id with the victim membership id',
      method: 'patch',
      path: (victim) => `/v1/memberships/${victim.membershipId}`,
      body: { role: 'CASHIER' },
    },
    {
      name: 'GET /v1/products/:id with the victim product id',
      method: 'get',
      path: (victim) => `/v1/products/${victim.productId}`,
    },
    {
      name: 'PATCH /v1/products/:id — repricing another shop’s product',
      method: 'patch',
      path: (victim) => `/v1/products/${victim.productId}`,
      body: { sellingPricePaise: 1 },
    },
    {
      name: 'DELETE /v1/products/:id — archiving another shop’s product',
      method: 'delete',
      path: (victim) => `/v1/products/${victim.productId}`,
    },
    {
      name: 'GET /v1/inventory/products/:productId — reading another shop’s stock',
      method: 'get',
      path: (victim) => `/v1/inventory/products/${victim.productId}`,
    },
  ]

  describe.each(attacks)('$name', ({ method, path, body }) => {
    it('returns 404 — never 403, never the data', async () => {
      const req = request(app.getHttpServer())
        [method](path(shopB))
        .set('Authorization', `Bearer ${shopA.token}`)

      const res = await (body ? req.send(body) : req)

      /*
       * 404, specifically.
       *
       * A 403 would confirm the resource exists, letting an attacker enumerate another shop's
       * sale ids, customer ids and membership ids by probing status codes. "Absent" and
       * "belongs to someone else" must be indistinguishable from outside (§23.3).
       */
      expect(res.status).toBe(404)
      expect(JSON.stringify(res.body)).not.toContain('Gupta')
    })
  })

  it('does not mutate the victim, even on a route that returns 404', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/memberships/${shopB.membershipId}`)
      .set('Authorization', `Bearer ${shopA.token}`)
      .send({ role: 'CASHIER' })
      .expect(404)

    // Shop B's owner must still be an OWNER. A write that "fails" with 404 but lands anyway
    // would be the worst possible outcome — silent, and a privilege change.
    const b = await request(app.getHttpServer())
      .get('/v1/memberships')
      .set('Authorization', `Bearer ${shopB.token}`)
      .expect(200)
    expect(b.body.data[0].role).toBe('OWNER')
  })

  it('leaves the victim’s product untouched after a cross-tenant write attempt', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/products/${shopB.productId}`)
      .set('Authorization', `Bearer ${shopA.token}`)
      .send({ sellingPricePaise: 1 })
      .expect(404)

    const survived = await request(app.getHttpServer())
      .get(`/v1/products/${shopB.productId}`)
      .set('Authorization', `Bearer ${shopB.token}`)
      .expect(200)

    // A 404 that nonetheless repriced the product would be the worst possible outcome: silent,
    // and directly costing the other shop money on every subsequent sale.
    expect(survived.body.data.sellingPricePaise).toBe(5000)
    expect(survived.body.data.archivedAt).toBeNull()
  })

  it('rejects a token whose shop claim was swapped for another shop', async () => {
    // A forged claim cannot help: the guard re-reads the membership from the database, and no
    // membership links Shop A's user to Shop B.
    const [header, payload, signature] = shopA.token.split('.')
    const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString())
    decoded.shopId = shopB.shopId
    const tampered = `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`

    const res = await request(app.getHttpServer())
      .get('/v1/shops/current')
      .set('Authorization', `Bearer ${tampered}`)
    expect(res.status).toBe(401) // signature no longer verifies
  })

  /**
   * Route coverage.
   *
   * Walks the application's route table and asserts that every parameterised route is either
   * exercised by the attack matrix above or explicitly exempt. This is what makes the suite
   * *generated* rather than merely thorough: a new `GET /v1/products/:id` fails this test on the
   * day it is written, not the day it leaks.
   */
  it('covers every id-bearing route with an isolation attack', () => {
    // Read Nest's own route metadata rather than Express internals: the latter moved between
    // Express 4 and 5, and this assertion must not break on a framework upgrade.
    const parameterisedRoutes = enumerateRoutes(app)
      .filter((route) => route.path.includes(':'))
      .map((route) => `${route.method} ${route.path}`)

    const covered = new Set(
      attacks.map((a) => {
        const templated = a
          .path(shopB)
          .replace(shopB.shopId, ':id')
          .replace(shopB.membershipId, ':id')
          .replace(`/inventory/products/${shopB.productId}`, '/inventory/products/:productId')
          .replace(shopB.productId, ':id')
        return `${a.method.toUpperCase()} ${templated}`
      }),
    )

    const uncovered = parameterisedRoutes.filter((route) => !covered.has(route))

    expect(
      uncovered,
      `These routes accept a resource id but have no tenant-isolation attack in the matrix ` +
        `above. Add one to \`attacks\` (blueprint §26.3): ${uncovered.join(', ')}`,
    ).toEqual([])
  })

  /**
   * Default-deny, verified across the whole route table (blueprint §23.2).
   *
   * The AuthGuard rejects an undeclared route at runtime, but that only helps if someone calls
   * it. This assertion fails the build the moment such a route is written, which is when it is
   * cheap to fix.
   */
  it('requires every route to declare its authorization explicitly', () => {
    const undeclared = enumerateRoutes(app)
      .filter((route) => !route.isPublic && route.permissions === undefined)
      .map((route) => `${route.method} ${route.path}`)

    expect(
      undeclared,
      `These routes declare neither @Public() nor @RequirePermission(). Authorization is ` +
        `default-deny (blueprint §23.2): ${undeclared.join(', ')}`,
    ).toEqual([])
  })
})
