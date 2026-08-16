import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { resolveEffectivePermissions } from '@dukaano/business-logic'
import { isPermission, type Permission, type ShopRole } from '@dukaano/types'
import { env } from '../../config/env'
import {
  NoShopMembershipError,
  PermissionDeniedError,
  UnauthorizedError,
} from '../errors/domain-error'
import { PrismaService } from '../prisma/prisma.service'
import { PERMISSIONS_KEY, PUBLIC_KEY } from '../decorators'
import { findMembershipForShop } from '../../modules/auth/membership-lookup'
import type { AccessTokenPayload, AuthenticatedRequest, RequestPrincipal } from './types'

/**
 * Authentication and permission enforcement, in one guard.
 *
 * Combining them is deliberate. As two guards, the permission check depends on the auth guard
 * having run first, and Nest's guard ordering is positional — a reordering during a refactor
 * would silently disable authorization while every test still passed. One guard resolves the
 * principal and checks it in a single pass, so the dependency cannot be broken by accident.
 *
 * **Default-deny (blueprint §23.2):** a route with neither `@Public()` nor `@RequirePermission()`
 * is rejected. Forgetting to declare authorization produces a loud failure on the first request
 * rather than a quietly open endpoint. A CI test also walks the route table and fails the build,
 * so this runtime check is the second line of defence rather than the only one.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      PERMISSIONS_KEY,
      targets,
    )

    if (required === undefined) {
      throw new UnauthorizedError(
        'errors.unknown',
        'Route declares no authorization. Add @Public() or @RequirePermission() (blueprint §23.2).',
      )
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const principal = await this.resolvePrincipal(request)
    request.principal = principal

    for (const permission of required) {
      if (!principal.permissions.has(permission)) throw new PermissionDeniedError(permission)
    }

    return true
  }

  private async resolvePrincipal(request: AuthenticatedRequest): Promise<RequestPrincipal> {
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('errors.auth.sessionExpired', 'Missing bearer token')
    }

    let payload: AccessTokenPayload
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7), {
        secret: env.JWT_ACCESS_SECRET,
      })
    } catch {
      // Deliberately opaque: distinguishing "expired" from "malformed" from "wrong signature"
      // tells an attacker which of those they achieved.
      throw new UnauthorizedError('errors.auth.sessionExpired', 'Invalid or expired access token')
    }

    /*
     * Permissions are re-resolved from the database on every request, never trusted from the
     * token. The token's `permHash` is a freshness hint only.
     *
     * This costs one indexed lookup per request, and it buys the property that revoking a
     * cashier's permission takes effect on their very next request — not up to 15 minutes later
     * when their access token happens to expire. For a permission like `customer.ledger.adjust`,
     * a 15-minute window is 15 minutes in which a dismissed employee can still erase debts.
     *
     * The lookup goes through the SECURITY DEFINER function because `shop_membership` is
     * RLS-protected and the tenant context is not open yet — the interceptor that opens it runs
     * *after* this guard, using the shop id this guard resolves. The function is parameterised on
     * user id alone, so a token claiming another shop simply finds no matching membership.
     */
    const membership = await findMembershipForShop(
      this.prisma.untenanted,
      payload.sub,
      payload.shopId,
    )

    if (!membership) throw new NoShopMembershipError()
    if (membership.userStatus !== 'ACTIVE') {
      throw new UnauthorizedError('errors.auth.accountSuspended', 'User account is not active')
    }
    if (membership.shopArchivedAt || membership.shopStatus === 'SUSPENDED') {
      throw new UnauthorizedError('errors.auth.accountSuspended', 'Shop is not active')
    }

    return {
      userId: payload.sub,
      shopId: payload.shopId,
      role: membership.role as ShopRole,
      permissions: resolveEffectivePermissions(
        membership.role as ShopRole,
        parseOverrides(membership.permissionOverrides),
      ),
      deviceId: payload.deviceId ?? null,
      membershipId: membership.membershipId,
    }
  }
}

/**
 * Read the JSONB overrides column defensively.
 *
 * It is untyped storage that a migration, an admin screen bug or a malicious sync payload could
 * corrupt, so unrecognised permission strings are dropped rather than passed through. The
 * ROLE_CEILING in @dukaano/business-logic is applied after this regardless, so even a fully
 * hostile value here cannot escalate a Cashier — this is belt as well as braces.
 */
function parseOverrides(raw: unknown): { grant: Permission[]; revoke: Permission[] } {
  const empty = { grant: [], revoke: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty

  const record = raw as Record<string, unknown>
  const readList = (value: unknown): Permission[] =>
    Array.isArray(value) ? value.filter(isPermission) : []

  return { grant: readList(record.grant), revoke: readList(record.revoke) }
}
