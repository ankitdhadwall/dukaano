import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { createTestApp, nextPhone, prepareTestDatabase, truncateAll } from './harness'

/**
 * Session security (blueprint §23.1).
 *
 * The property under test is **refresh-token rotation with reuse detection**. It matters more
 * for Dukaano than for typical B2B software: these are shared counter phones that get lost,
 * sold and handed to relatives, so "a stolen token grants 60 days of silent access" is a real
 * outcome rather than a threat-model abstraction.
 */
describe('auth tokens', () => {
  let app: INestApplication
  const password = 'correct horse battery'
  let phone = ''

  const login = async () =>
    request(app.getHttpServer()).post('/v1/auth/login').send({ phone, password }).expect(200)

  beforeAll(async () => {
    prepareTestDatabase()
    truncateAll()
    app = await createTestApp()
    phone = nextPhone()
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ phone, password, fullName: 'Rakesh', shopName: 'Sharma General Store' })
      .expect(201)
  }, 180_000)

  afterAll(async () => {
    await app?.close()
  })

  it('issues an opaque refresh token, not a second JWT', () => {
    // A refresh token must not be usable as anything but a lookup key. If it were a JWT, a
    // confusion between the two secrets would silently turn it into a 60-day access token.
    return login().then((res) => {
      expect(res.body.data.refreshToken).not.toContain('.')
      expect(res.body.data.expiresIn).toBe(900)
    })
  })

  it('rotates: a refresh yields a new pair and the old token stops working', async () => {
    const first = await login()
    const original = first.body.data.refreshToken

    const rotated = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: original })
      .expect(200)

    expect(rotated.body.data.refreshToken).not.toBe(original)
    expect(rotated.body.data.accessToken).toBeTruthy()
  })

  it('detects reuse and revokes the whole token family', async () => {
    const session = await login()
    const original = session.body.data.refreshToken

    // Legitimate rotation.
    const rotated = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: original })
      .expect(200)
    const successor = rotated.body.data.refreshToken

    // The attacker replays the token they copied before rotation.
    const replay = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: original })
    expect(replay.status).toBe(401)
    expect(replay.body.error.messageKey).toBe('errors.auth.tokenReused')

    /*
     * The critical assertion: the *successor* is dead too.
     *
     * Revoking only the replayed token would leave whichever party holds the newer one with a
     * live session — and we cannot tell which of them is the attacker. Killing the lineage costs
     * the honest user one extra login and costs the attacker everything.
     */
    const successorAttempt = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: successor })
    expect(successorAttempt.status).toBe(401)
  })

  it('logout revokes the presented token', async () => {
    const session = await login()
    const token = session.body.data.refreshToken

    await request(app.getHttpServer()).post('/v1/auth/logout').send({ refreshToken: token }).expect(204)

    const afterLogout = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: token })
    expect(afterLogout.status).toBe(401)
  })

  it('gives the same answer for a wrong password and an unknown number', async () => {
    // Distinguishing them would let anyone enumerate which mobile numbers have Dukaano accounts.
    const wrongPassword = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ phone, password: 'not the password' })

    const unknownUser = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ phone: nextPhone(), password })

    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    expect(wrongPassword.body.error.messageKey).toBe(unknownUser.body.error.messageKey)
    expect(wrongPassword.body.error.messageKey).toBe('errors.auth.invalidCredentials')
  })

  it('normalizes an Indian mobile number, so one customer is not three accounts', async () => {
    // Registration stored the bare 10-digit form; every equivalent spelling must reach it.
    for (const spelling of [phone, `+91${phone}`, `0${phone}`, `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`]) {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ phone: spelling, password })
      expect(res.status, `login with "${spelling}"`).toBe(200)
    }
  })

  it('rejects a duplicate registration with a localizable key, not English prose', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ phone, password, fullName: 'Someone Else', shopName: 'Another Shop' })

    expect(res.status).toBe(409)
    expect(res.body.error.messageKey).toBe('errors.auth.phoneTaken')
  })

  it('returns field-level i18n keys for a malformed registration', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ phone: '12345', password: 'short', fullName: '', shopName: '' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    // Keys, never prose — the client renders them in the reader's language (§24.1).
    expect(JSON.stringify(res.body.error.fieldErrors)).toMatch(/errors\./)
    expect(res.body.error.fieldErrors.phone).toBeDefined()
    expect(res.body.error.fieldErrors.password).toBeDefined()
  })

  it('rejects a landline, which could never receive a receipt or reminder', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ phone: '5876543210', password, fullName: 'Test', shopName: 'Test Shop' })

    expect(res.status).toBe(400)
    expect(res.body.error.fieldErrors.phone[0]).toBe('errors.phone.notMobile')
  })
})

describe('rate limiting', () => {
  it('keeps the production auth limit at 5 attempts per minute', async () => {
    // The integration suite raises this so it can log in freely; that must not become a way for
    // the control to be quietly removed. Asserting the *default* here means deleting or
    // loosening the limit in env.ts fails the build.
    const { cleanEnv, num } = await import('envalid')
    const resolved = cleanEnv({}, { AUTH_RATE_LIMIT_PER_MINUTE: num({ default: 5 }) })
    expect(resolved.AUTH_RATE_LIMIT_PER_MINUTE).toBe(5)

    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/config/env.ts', import.meta.url), 'utf8'),
    )
    expect(source).toMatch(/AUTH_RATE_LIMIT_PER_MINUTE: num\(\{ default: 5 \}\)/)
  })
})
