import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/*
 * NOTE: `src/app.module` is imported DYNAMICALLY inside createTestApp(), not at the top of this
 * file.
 *
 * `src/config/env.ts` validates process.env at module-load time — deliberately, so a
 * misconfigured deploy fails at boot rather than on the first request that touches the bad
 * value. ES import declarations are hoisted and evaluated before any statement in this module
 * runs, so a static import here would evaluate env.ts before the assignments in createTestApp()
 * had a chance to point it at the test database. The symptom is subtle and alarming: the suite
 * silently runs against the *development* database.
 */

/**
 * Integration-test harness.
 *
 * Tests run against a **real PostgreSQL** with real RLS policies and real constraints. That is
 * non-negotiable here: the majority of Dukaano's isolation and integrity guarantees are enforced
 * by the database, so a mocked or in-memory store would test nothing that matters. A suite that
 * passes against a fake and fails against Postgres is worse than no suite.
 *
 * Blueprint §26.1 specifies Testcontainers. This harness instead targets a Postgres reached via
 * `DATABASE_URL_TEST`, which the same docker-compose stack already provides locally and a CI
 * service container provides in the pipeline. Same guarantee — a real, isolated Postgres per run
 * — without paying container startup on every local invocation. Recorded as a deviation in
 * docs/phase-1-status.md.
 */

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL_TEST ??
  'postgresql://dukaano:dukaano_dev_only@localhost:5433/dukaano_test?schema=public'
const APP_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://dukaano_app:dukaano_dev_only@localhost:5433/dukaano_test?schema=public'

/**
 * Convert a Prisma connection string into one libpq accepts.
 *
 * `?schema=public` is Prisma's own parameter and psql rejects it outright with
 * `invalid URI query parameter: "schema"`. The previous harness never noticed, because a failing
 * psql call fell back to `docker exec` — so the bad URL was masked locally and the whole suite
 * collapsed in CI, where there is no such container. Stripping it here keeps one connection string
 * in the environment for both tools.
 */
function libpqUrl(url: string): string {
  return url.replace(/[?&]schema=[^&]*/g, '').replace(/\?$/, '')
}

/**
 * Run a statement against the test database as the **owner**, and return its output.
 *
 * Every test that needs to inspect or set up raw state goes through here.
 *
 * It talks to `psql` over `DATABASE_ADMIN_URL_TEST` rather than shelling out to
 * `docker exec dukaano-postgres`, which is what the first version did. That version worked on
 * exactly one machine: it hardcoded a local container name, so the whole integration suite failed
 * in CI — where Postgres is a service container with a different name — and would fail for any
 * developer whose container was named differently. A connection string is the thing both
 * environments genuinely share.
 *
 * As the owner, deliberately: setup and assertions need to see across tenants and to write state
 * the application role is not permitted to write. The application itself connects as
 * `dukaano_app` and is RLS-constrained, which is what the tests are checking.
 */
export function sql(statement: string): string {
  return execSync(`psql "${libpqUrl(ADMIN_URL)}" -v ON_ERROR_STOP=1 -qtAc ${JSON.stringify(statement)}`, {
    stdio: 'pipe',
    shell: '/bin/bash',
  })
    .toString()
    .trim()
}

/** The same, parsed as a number. Empty output (no rows) reads as 0. */
export function sqlNumber(statement: string): number {
  return Number(sql(statement) || '0')
}

/**
 * Run a statement as the **application role** — RLS-constrained, exactly as the API connects.
 *
 * Distinct from `sql` on purpose. A test that wants to prove the application role *cannot* do
 * something has to actually be that role; running it as the owner would prove nothing, and
 * collapsing the two helpers into one would quietly turn those tests into no-ops.
 */
export function appSql(statement: string): string {
  return execSync(`psql "${libpqUrl(APP_URL)}" -v ON_ERROR_STOP=1 -qtAc ${JSON.stringify(statement)}`, {
    stdio: 'pipe',
    shell: '/bin/bash',
  })
    .toString()
    .trim()
}

/** Create the test database (if absent) and bring it to the current migration state. */
export function prepareTestDatabase(): void {
  const bootstrapUrl = libpqUrl(ADMIN_URL).replace(/\/dukaano_test/, '/postgres')
  execSync(
    `psql "${bootstrapUrl}" -tAc "SELECT 1 FROM pg_database WHERE datname='dukaano_test'" | grep -q 1 || psql "${bootstrapUrl}" -c "CREATE DATABASE dukaano_test"`,
    { stdio: 'pipe', shell: '/bin/bash' },
  )

  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: ADMIN_URL },
  })

  /*
   * Seed the platform catalogue — plans, master categories, master products.
   *
   * These are NOT tenant tables: they have no `shop_id`, no RLS policy, and `truncateAll()`
   * deliberately leaves them alone. Master-catalogue adoption is what a shopkeeper's first
   * session actually does, so testing it against an empty platform catalogue would be testing
   * nothing. The seed upserts, so repeated runs are free.
   */
  execSync('pnpm exec tsx prisma/seed.ts', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: ADMIN_URL, SEED_PLATFORM_ONLY: 'true', NODE_ENV: 'test' },
  })
}

export async function createTestApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = APP_URL
  process.env.NODE_ENV = 'test'
  process.env.JWT_ACCESS_SECRET = 'test_access_secret_at_least_32_characters_long_xx'
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_at_least_32_characters_long_x'
  // The suite performs far more logins per minute than a human would. The limit itself is
  // asserted at its production default in auth-tokens.spec.ts, so raising it here cannot hide a
  // regression that removes the control.
  process.env.AUTH_RATE_LIMIT_PER_MINUTE = '1000'
  // Cron handlers still register; they just do not fire. A reconciliation sweep running mid-suite
  // would read a database the tests are actively mutating and report phantom mismatches.
  process.env.ENABLE_SCHEDULED_JOBS = 'false'

  // Dynamic, so env.ts validates AFTER the assignments above. See the note at the top of the file.
  const { AppModule } = await import('../src/app.module')
  const { DomainExceptionFilter } = await import('../src/common/errors/domain-exception.filter')

  const { configureBodyParser } = await import('../src/bootstrap')

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  // The same body-parser configuration production uses. Tests build the app from AppModule and
  // never run main.ts, so anything configured only there would be untested — which is exactly how
  // the 5,000-row import first failed. See src/bootstrap.ts.
  const app = moduleRef.createNestApplication<NestExpressApplication>(undefined, {
    bodyParser: false,
  })
  configureBodyParser(app)
  app.useGlobalFilters(new DomainExceptionFilter())
  await app.init()

  // Fail loudly rather than silently testing the wrong database — the exact failure the dynamic
  // import above exists to prevent, asserted so a regression cannot reintroduce it quietly.
  const { PrismaService } = await import('../src/common/prisma/prisma.service')
  const prisma = app.get(PrismaService)
  const [row] = await prisma.untenanted.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (row?.db !== 'dukaano_test') {
    throw new Error(
      `Integration tests are connected to "${row?.db}", not "dukaano_test". Refusing to run.`,
    )
  }

  return app
}

/** Remove all tenant data between tests, as the owner so RLS does not hide anything. */
export function truncateAll(): void {
  sql('TRUNCATE shop, "user" CASCADE')
}

export interface SeededShop {
  shopId: string
  ownerId: string
  ownerPhone: string
  accessToken: string
  refreshToken: string
}

/** A distinct valid Indian mobile per call, so shops never collide on the phone unique index. */
let phoneCounter = 0
export function nextPhone(): string {
  phoneCounter += 1
  return `98765${String(43000 + phoneCounter).padStart(5, '0')}`
}

export const asUuid = (): string => randomUUID()
