import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma } from '@prisma/client'

/**
 * The per-request tenant context.
 *
 * Held in AsyncLocalStorage rather than passed as a parameter through every call, for one
 * specific reason: it makes "forgot to pass the transaction" **impossible** rather than merely
 * discouraged. A service that reaches for the database gets the request's tenant-scoped
 * transaction or it gets an error — there is no third option where it silently gets a
 * connection with no `app.shop_id` set and therefore, thanks to RLS, an empty database.
 */

/** The Prisma client bound to an open transaction with `app.shop_id` already set. */
export type TenantClient = Omit<Prisma.TransactionClient, '$transaction'>

export interface RequestContext {
  readonly requestId: string
  /** Null for unauthenticated routes (login, register, health). */
  readonly shopId: string | null
  readonly userId: string | null
  readonly deviceId: string | null
  /** The tenant-scoped transaction. Null on routes that never touch tenant data. */
  readonly tx: TenantClient | null
  readonly ipAddress?: string
  readonly userAgent?: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

/** The current context, or null outside a request (background jobs, boot). */
export function currentContext(): RequestContext | null {
  return storage.getStore() ?? null
}

/**
 * The current tenant transaction.
 *
 * Throws rather than returning null: a service reaching for tenant data outside a tenant
 * transaction is a programming error, and failing loudly here is far better than the alternative
 * — RLS silently returning zero rows, which reads to a developer as "the data isn't there" and
 * to a shopkeeper as "my products disappeared".
 */
export function tenantClient(): TenantClient {
  const context = storage.getStore()
  if (!context?.tx) {
    throw new Error(
      'No tenant transaction is open. Tenant data may only be accessed inside a request ' +
        'handled by TenantTransactionInterceptor. If this is a background job, open one ' +
        'explicitly with PrismaService.runAsTenant(shopId, fn).',
    )
  }
  return context.tx
}

/** The current shop id. Throws if there is no tenant context. */
export function currentShopId(): string {
  const shopId = storage.getStore()?.shopId
  if (!shopId) throw new Error('No shop context is set on this request.')
  return shopId
}
