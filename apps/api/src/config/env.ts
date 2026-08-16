import { bool, cleanEnv, num, str, url } from 'envalid'

/**
 * Environment validation (blueprint §46, §23.5).
 *
 * The API **refuses to start** if a variable is missing or malformed. The alternative — booting
 * with `undefined` and discovering it when the first request touches that code path — turns a
 * five-second config mistake into a production incident, and in this system that code path might
 * be the one that signs tokens or connects to the database.
 */
export const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  PORT: num({ default: 3000 }),

  /**
   * The application connection. This role MUST NOT be the table owner and MUST NOT hold
   * BYPASSRLS — tenant isolation depends on it (§13). PrismaService asserts both at boot.
   */
  DATABASE_URL: url(),

  REDIS_URL: url({ default: 'redis://localhost:6380' }),

  JWT_ACCESS_SECRET: str({ desc: '32+ bytes. openssl rand -base64 48' }),
  JWT_REFRESH_SECRET: str({ desc: '32+ bytes, distinct from the access secret' }),
  /**
   * Access-token lifetime in **seconds**, not a duration string.
   *
   * `jsonwebtoken` accepts both, but the string form is typed as a template literal union that a
   * plain env var cannot satisfy without a cast — and a cast here would be asserting a format we
   * never actually validate. An integer is unambiguous, needs no cast, and cannot be typo'd into
   * something that silently parses as a different unit ('15' meaning 15 seconds, not minutes).
   */
  JWT_ACCESS_TTL_SECONDS: num({ default: 900 }), // 15 minutes
  JWT_REFRESH_TTL_DAYS: num({ default: 60 }),

  /**
   * Login/registration attempts allowed per minute per IP (blueprint §21).
   *
   * Credential stuffing against Indian mobile numbers is cheap — the number space is small and
   * predictable — so 5 is a real control, not boilerplate. It is configurable ONLY so the
   * integration suite can perform more logins in a minute than a human ever would; the default
   * is the production value and `auth-tokens.spec.ts` asserts that default has not been relaxed.
   */
  AUTH_RATE_LIMIT_PER_MINUTE: num({ default: 5 }),

  CORS_ORIGINS: str({ default: 'http://localhost:3001,http://localhost:3002' }),
  LOG_LEVEL: str({ choices: ['trace', 'debug', 'info', 'warn', 'error'], default: 'info' }),

  /**
   * Escape hatch for local development against a database where the app role happens to be the
   * owner. Never set in staging or production; the boot assertion logs loudly when it is on.
   */
  ALLOW_INSECURE_DB_ROLE: bool({ default: false }),

  /**
   * Whether cron jobs run in this process.
   *
   * Off in tests, so a sweep does not fire mid-suite against a database the tests are mutating.
   * Off on any replica that is not the designated scheduler once the API runs on more than one
   * instance — otherwise every instance reconciles every shop, N times a night, for nothing.
   */
  ENABLE_SCHEDULED_JOBS: bool({ default: true }),
})

export type Env = typeof env

/** Secrets shorter than this are rejected outright rather than merely warned about. */
const MIN_SECRET_LENGTH = 32

export function assertSecretsAreStrong(e: Env): void {
  const weak: string[] = []
  if (e.JWT_ACCESS_SECRET.length < MIN_SECRET_LENGTH) weak.push('JWT_ACCESS_SECRET')
  if (e.JWT_REFRESH_SECRET.length < MIN_SECRET_LENGTH) weak.push('JWT_REFRESH_SECRET')
  if (e.JWT_ACCESS_SECRET === e.JWT_REFRESH_SECRET) {
    // Sharing one secret means a refresh token is a valid access token and never expires in
    // 15 minutes — it silently converts the whole rotation scheme into a no-op.
    weak.push('JWT_REFRESH_SECRET (must differ from JWT_ACCESS_SECRET)')
  }

  if (weak.length > 0 && e.NODE_ENV === 'production') {
    throw new Error(`Refusing to start: weak or duplicated secrets — ${weak.join(', ')}`)
  }
  if (weak.length > 0) {
    console.warn(`⚠️  Weak secrets (tolerated outside production): ${weak.join(', ')}`)
  }
}

export const corsOrigins = (e: Env): string[] =>
  e.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
