import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ROLE_CEILING, ROLE_DEFAULTS, hasPermission } from '@dukaano/business-logic'
import { SHOP_ROLES, type Permission, type ShopRole } from '@dukaano/types'
import { createTestApp, nextPhone, prepareTestDatabase, truncateAll } from './harness'
import { enumerateRoutes } from './route-table'

/**
 * Per-route authorization (blueprint §9, §23.2, §26.3) — Phase 1 acceptance criterion 3.
 *
 * The RBAC matrix itself is unit-tested to 100% in @dukaano/business-logic. What that cannot
 * prove is that the matrix is actually *wired to the routes*: a controller with the wrong
 * decorator, or none, passes every unit test while leaving an endpoint open. So this suite logs
 * in as each of the three real roles and drives every route through HTTP.
 */
describe('authorization', () => {
  let app: INestApplication
  const tokens: Record<ShopRole, string> = { OWNER: '', MANAGER: '', CASHIER: '' }
  let ownerMembershipId = ''
  let cashierMembershipId = ''

  const authed = (role: ShopRole) => ({ Authorization: `Bearer ${tokens[role]}` })

  beforeAll(async () => {
    prepareTestDatabase()
    truncateAll()
    app = await createTestApp()

    // Owner: created by registration.
    const ownerPhone = nextPhone()
    const registered = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        phone: ownerPhone,
        password: 'correct horse battery',
        fullName: 'Rakesh Sharma',
        shopName: 'Sharma General Store',
      })
      .expect(201)
    tokens.OWNER = registered.body.data.accessToken

    const me = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set(authed('OWNER'))
      .expect(200)
    ownerMembershipId = me.body.data.membershipId

    // Manager and Cashier: invited by the Owner, then logged in as themselves.
    for (const role of ['MANAGER', 'CASHIER'] as const) {
      const phone = nextPhone()
      const invited = await request(app.getHttpServer())
        .post('/v1/memberships')
        .set(authed('OWNER'))
        .send({
          phone,
          fullName: role === 'MANAGER' ? 'Priya Sharma' : 'Sunil',
          role,
          temporaryPassword: 'temporary pass 123',
        })
        .expect(201)

      if (role === 'CASHIER') cashierMembershipId = invited.body.data.id

      const login = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ phone, password: 'temporary pass 123' })
        .expect(200)
      tokens[role] = login.body.data.accessToken
    }
  }, 180_000)

  afterAll(async () => {
    await app?.close()
  })

  it('issues a working token for all three roles', () => {
    for (const role of SHOP_ROLES) expect(tokens[role], `${role} token`).toBeTruthy()
  })

  it('reports each role its own effective permissions', async () => {
    for (const role of SHOP_ROLES) {
      const res = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set(authed(role))
        .expect(200)

      expect(res.body.data.role).toBe(role)
      // What the API reports must be exactly what the pure matrix computes — if these ever
      // disagree, one of them is lying to somebody.
      expect(res.body.data.permissions.sort()).toEqual([...ROLE_DEFAULTS[role]].sort())
    }
  })

  /**
   * The route × role matrix.
   *
   * Each entry names the permission a route requires; the expectations are then *derived* from
   * the RBAC matrix rather than hand-written per role. That means changing a role default in
   * @dukaano/business-logic automatically changes what this suite demands of the API, and the
   * two cannot drift apart.
   */
  const protectedRoutes: {
    name: string
    permission: Permission
    call: (server: unknown, headers: Record<string, string>) => request.Test
  }[] = [
    {
      name: 'GET /v1/memberships',
      permission: 'employee.manage',
      call: (server, headers) =>
        request(server as never)
          .get('/v1/memberships')
          .set(headers),
    },
    {
      name: 'PATCH /v1/shops/current',
      permission: 'settings.manage',
      call: (server, headers) =>
        request(server as never)
          .patch('/v1/shops/current')
          .set(headers)
          .send({ name: 'Renamed Store' }),
    },
    {
      name: 'PATCH /v1/shops/current/settings',
      permission: 'settings.manage',
      call: (server, headers) =>
        request(server as never)
          .patch('/v1/shops/current/settings')
          .set(headers)
          .send({ negativeStockPolicy: 'WARN' }),
    },
  ]

  describe.each(protectedRoutes)('$name (requires $permission)', ({ permission, call }) => {
    it.each(SHOP_ROLES)('%s is allowed exactly when the matrix says so', async (role) => {
      const res = await call(app.getHttpServer(), authed(role))
      const shouldBeAllowed = hasPermission(role, permission)

      if (shouldBeAllowed) {
        expect(res.status, `${role} should reach this route`).not.toBe(403)
      } else {
        expect(res.status, `${role} must be refused`).toBe(403)
        expect(res.body.error.code).toBe('PERMISSION_DENIED')
        // The message names the missing permission and who can grant it — a bare "Forbidden"
        // leaves a cashier with no idea what to do next (§24.1).
        expect(res.body.error.messageKey).toBe('errors.permission.denied')
        expect(res.body.error.params.action).toBe(permission)
      }
    })
  })

  it('refuses an unauthenticated request to every non-public route', async () => {
    const nonPublic = enumerateRoutes(app).filter((route) => !route.isPublic)
    expect(nonPublic.length).toBeGreaterThan(0)

    for (const route of nonPublic) {
      const path = route.path.replace(/:[^/]+/g, '00000000-0000-4000-8000-000000000000')
      const res = await request(app.getHttpServer())
        [route.method.toLowerCase() as 'get'](path)
        .send({})
      expect(res.status, `${route.method} ${route.path} must require a token`).toBe(401)
    }
  })

  describe('the role ceiling is enforced over HTTP, not just in the pure matrix', () => {
    it.each(ROLE_CEILING.CASHIER)(
      'refuses to grant %s to a Cashier even when the Owner asks',
      async (permission) => {
        const res = await request(app.getHttpServer())
          .patch(`/v1/memberships/${cashierMembershipId}`)
          .set(authed('OWNER'))
          .send({ permissionOverrides: { grant: [permission] } })

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('PERMISSION_NOT_GRANTABLE')
      },
    )

    it('still allows a grantable permission, so the ceiling is not just blocking everything', async () => {
      // The common real case: an Owner trusting a cashier to take khata payments.
      const res = await request(app.getHttpServer())
        .patch(`/v1/memberships/${cashierMembershipId}`)
        .set(authed('OWNER'))
        .send({ permissionOverrides: { grant: ['customer.payment.receive'] } })
        .expect(200)

      expect(res.body.data.permissionOverrides.grant).toContain('customer.payment.receive')
    })

    it('applies the granted permission on the cashier’s very next request', async () => {
      // Permissions are re-read from the database per request rather than trusted from the token,
      // so this takes effect immediately — not when the 15-minute access token expires.
      const res = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set(authed('CASHIER'))
        .expect(200)
      expect(res.body.data.permissions).toContain('customer.payment.receive')
      // …and the ceiling still holds alongside the grant.
      expect(res.body.data.permissions).not.toContain('product.view.cost')
    })
  })

  it('stops an Owner locking themselves out of their own shop', async () => {
    // Without this rule a shop can be left with no Owner at all — nobody able to manage staff,
    // change settings or handle billing — recoverable only by us touching their database.
    const res = await request(app.getHttpServer())
      .patch(`/v1/memberships/${ownerMembershipId}`)
      .set(authed('OWNER'))
      .send({ role: 'CASHIER' })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('CANNOT_MODIFY_SELF')
  })
})
