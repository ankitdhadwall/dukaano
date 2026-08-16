import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Entitlement, Permission } from '@dukaano/types'
import type { AuthenticatedRequest, RequestPrincipal } from '../guards/types'

/**
 * Route metadata and parameter decorators.
 *
 * Blueprint §23.2: authorization is **default-deny**. A route is unreachable unless it is either
 * explicitly marked `@Public()` or carries an explicit `@RequirePermission()`. The guard enforces
 * that at runtime and a CI test enforces it at build time by walking the route table, so a new
 * endpoint that forgets to declare its authorization simply cannot ship.
 */

export const PUBLIC_KEY = 'dukaano:public'
export const PERMISSIONS_KEY = 'dukaano:permissions'
export const ENTITLEMENTS_KEY = 'dukaano:entitlements'
export const SKIP_TENANT_KEY = 'dukaano:skipTenant'
export const AUDIT_KEY = 'dukaano:audit'
export const TRANSACTION_TIMEOUT_KEY = 'dukaano:transactionTimeout'

/** No authentication. Reserved for login, registration and health. */
export const Public = () => SetMetadata(PUBLIC_KEY, true)

/**
 * Authenticated, and holding every listed permission.
 *
 * Listing zero permissions is meaningful: it declares "any authenticated shop member may call
 * this", which is the correct marking for reads like the dashboard. It is an explicit statement,
 * not an omission, which is why the CI check accepts it.
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions)

/** The shop's plan must include every listed entitlement. Checked independently of permissions. */
export const RequireEntitlement = (...entitlements: Entitlement[]) =>
  SetMetadata(ENTITLEMENTS_KEY, entitlements)

/**
 * Do not open a tenant transaction for this route.
 *
 * For genuinely cross-tenant work only: login (which must find a user before any shop is known)
 * and the shop switcher. Everything else opens a transaction, because RLS makes an untenanted
 * query return zero rows rather than fail — a silent empty result is far harder to debug than a
 * loud error.
 */
export const SkipTenant = () => SetMetadata(SKIP_TENANT_KEY, true)

/** Record an audit entry for this route (blueprint §28). */
export const Audit = (action: string, entityType: string) =>
  SetMetadata(AUDIT_KEY, { action, entityType })

/**
 * Give this route a longer transaction budget than the 15 s default.
 *
 * The default is sized for a counter sale, where a request still holding row locks after fifteen
 * seconds is stuck and should be killed rather than left blocking the till during a rush. Bulk
 * operations legitimately take longer, and timing one out mid-write rolls back work the
 * shopkeeper stood and waited for.
 *
 * Marked per route rather than raised globally, so the tight default keeps protecting the
 * hundreds of routes that should never need it, and every exception is visible in review.
 */
export const LongTransaction = (milliseconds: number) =>
  SetMetadata(TRANSACTION_TIMEOUT_KEY, milliseconds)

/** The authenticated principal: user, shop, role and effective permissions. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestPrincipal => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>()
    if (!request.principal) {
      throw new Error('@CurrentUser() used on a route with no authentication guard.')
    }
    return request.principal
  },
)

/** The active shop id. */
export const CurrentShop = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>()
  const shopId = request.principal?.shopId
  if (!shopId) throw new Error('@CurrentShop() used on a route with no shop context.')
  return shopId
})
