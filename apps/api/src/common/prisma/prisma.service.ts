import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { env } from '../../config/env'
import { runWithContext, type RequestContext, type TenantClient } from './tenant-context'

/**
 * Prisma access, with tenancy enforced at the connection level.
 *
 * Blueprint §13 describes three independent isolation layers. This class owns the seam between
 * layer 1 (application) and layer 2 (database RLS): it is the only place that opens a
 * transaction and sets `app.shop_id`, and the only place that can hand out a client capable of
 * reading tenant data.
 *
 * **Composition, not inheritance.** The common pattern is `class PrismaService extends
 * PrismaClient`, and it works under `tsc` — but Prisma installs its model delegates (`.user`,
 * `.shop`, …) as own properties during construction, and transpilers that apply `[[Define]]`
 * class-field semantics (SWC, which the test runner uses for `emitDecoratorMetadata`) drop them
 * on the subclass. The failure mode is `this.prisma.user` being `undefined` at runtime in tests
 * while production works, which is a miserable thing to debug. Holding the client as a field
 * sidesteps the whole question and makes the tenant/untenanted distinction explicit at every
 * call site.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)

  private readonly client: PrismaClient = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

  async onModuleInit(): Promise<void> {
    await this.client.$connect()
    await this.assertRoleCannotBypassRls()
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect()
  }

  /**
   * Refuse to serve traffic on a connection that can bypass tenant isolation.
   *
   * This replaces `FORCE ROW LEVEL SECURITY` (see the RLS migration for the full reasoning).
   * FORCE would apply RLS to the table owner but would also break owner-run migrations and
   * seeds; this assertion instead catches the exact misconfiguration FORCE guards against —
   * pointing the API at the owner or a superuser connection string — and it **fails loudly at
   * boot** rather than silently changing query behaviour.
   *
   * Three ways a connection could bypass RLS, all checked:
   *   1. The role holds BYPASSRLS.
   *   2. The role is a superuser (which implies BYPASSRLS).
   *   3. The role owns the tables, and RLS is not FORCEd, so policies do not apply to it.
   */
  private async assertRoleCannotBypassRls(): Promise<void> {
    const [check] = await this.client.$queryRaw<
      { current_role: string; is_superuser: boolean; bypasses_rls: boolean; owns_tables: boolean }[]
    >`
      SELECT
        current_user::text                                                 AS current_role,
        (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user)   AS is_superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)   AS bypasses_rls,
        EXISTS (
          SELECT 1 FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'product' AND tableowner = current_user
        )                                                                   AS owns_tables
    `

    if (!check) throw new Error('Could not determine the database role. Refusing to start.')

    const problems: string[] = []
    if (check.is_superuser) problems.push('is a superuser')
    if (check.bypasses_rls) problems.push('holds BYPASSRLS')
    if (check.owns_tables) problems.push('owns the tables (RLS policies do not apply to the owner)')

    if (problems.length === 0) {
      this.logger.log(`Database role "${check.current_role}" is correctly RLS-constrained.`)
      return
    }

    const message =
      `Database role "${check.current_role}" ${problems.join(' and ')}. ` +
      `Tenant isolation (blueprint §13) would not be enforced. ` +
      `Point DATABASE_URL at the application role (dukaano_app), not the owner.`

    if (env.ALLOW_INSECURE_DB_ROLE) {
      this.logger.error(`⚠️  TENANT ISOLATION IS DISABLED — ${message}`)
      return
    }
    throw new Error(`Refusing to start: ${message}`)
  }

  /**
   * Open a tenant-scoped transaction and run `fn` inside it.
   *
   * `set_config(..., true)` is the parameterizable equivalent of `SET LOCAL`: it is scoped to
   * this transaction and reverts on commit or rollback, so a pooled connection can never leak
   * one shop's context into the next request that borrows it.
   *
   * A caveat worth recording now rather than discovering in production: this only holds under
   * **transaction-mode** pooling. If PgBouncer is introduced it must be configured that way, and
   * every tenant query must already be inside a transaction — which this method guarantees.
   */
  async runAsTenant<T>(
    context: Omit<RequestContext, 'tx'> & { shopId: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.shop_id', ${context.shopId}::text, true)`
        return runWithContext({ ...context, tx: tx as TenantClient }, fn)
      },
      {
        // Generous enough for a multi-line sale with per-product row locks; short enough that a
        // stuck request releases its locks rather than blocking the counter during a rush.
        timeout: 15_000,
        maxWait: 5_000,
      },
    )
  }

  /**
   * Run a transaction with the tenant context set, for code that already has a shop id but is
   * not inside a request (seeds, background jobs, registration — which creates the shop it then
   * writes into).
   */
  async withTenant<T>(
    shopId: string,
    fn: (tx: TenantClient) => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.shop_id', ${shopId}::text, true)`
      return fn(tx as TenantClient)
    })
  }

  /**
   * The client with no tenant context, for genuinely cross-tenant work: login (which must find a
   * user before any shop is known), platform catalogue reads, and health checks.
   *
   * Because RLS fails closed, this client sees **zero rows** in every tenant table. That is the
   * intended behaviour — an accidental call here cannot leak data; it simply returns nothing,
   * and the error message in tenant-context.ts explains why.
   */
  get untenanted(): PrismaClient {
    return this.client
  }
}
