import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
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

/** Create the test database (if absent) and bring it to the current migration state. */
export function prepareTestDatabase(): void {
  const bootstrapUrl = ADMIN_URL.replace(/\/dukaano_test/, '/postgres')
  try {
    execSync(
      `psql "${bootstrapUrl}" -tAc "SELECT 1 FROM pg_database WHERE datname='dukaano_test'" | grep -q 1 || psql "${bootstrapUrl}" -c "CREATE DATABASE dukaano_test"`,
      { stdio: 'pipe', shell: '/bin/bash' },
    )
  } catch {
    // psql may not be on PATH; fall back to the containerised client.
    execSync(
      `docker exec dukaano-postgres psql -U dukaano -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='dukaano_test'" | grep -q 1 || docker exec dukaano-postgres psql -U dukaano -d postgres -c "CREATE DATABASE dukaano_test"`,
      { stdio: 'pipe', shell: '/bin/bash' },
    )
  }

  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: ADMIN_URL },
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

  // Dynamic, so env.ts validates AFTER the assignments above. See the note at the top of the file.
  const { AppModule } = await import('../src/app.module')
  const { DomainExceptionFilter } = await import('../src/common/errors/domain-exception.filter')

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()
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
  execSync(
    `docker exec dukaano-postgres psql -U dukaano -d dukaano_test -qc ` +
      `"TRUNCATE shop, \\"user\\" CASCADE;"`,
    { stdio: 'pipe', shell: '/bin/bash' },
  )
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
