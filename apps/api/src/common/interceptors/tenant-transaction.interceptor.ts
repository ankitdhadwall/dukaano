import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { randomUUID } from 'node:crypto'
import { Observable, from } from 'rxjs'
import { firstValueFrom } from 'rxjs'
import { PrismaService } from '../prisma/prisma.service'
import { runWithContext } from '../prisma/tenant-context'
import { SKIP_TENANT_KEY } from '../decorators'
import type { AuthenticatedRequest } from '../guards/types'

/**
 * Opens a tenant-scoped transaction around every request that touches tenant data.
 *
 * Blueprint §12: this is what makes "no repository method can be called outside a tenant-scoped
 * transaction" true rather than aspirational. The handler runs *inside* `$transaction`, so:
 *
 *   • `app.shop_id` is set for every query the handler makes, and RLS applies;
 *   • a handler that writes a sale, its items, its payment and its stock movements either
 *     commits all of them or none — the §27 atomicity requirement comes free, per request,
 *     rather than being remembered service by service;
 *   • any thrown error rolls the whole thing back before the exception filter ever sees it.
 *
 * The interceptor runs AFTER guards, which is required: the shop id comes from the principal the
 * guard resolved. Nest's execution order (guards → interceptors → handler) guarantees this.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const requestId = request.requestId ?? randomUUID()
    request.requestId = requestId

    const skipTenant = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ])

    const principal = request.principal
    const base = {
      requestId,
      userId: principal?.userId ?? null,
      deviceId: principal?.deviceId ?? null,
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    }

    // Public routes and the shop switcher run without a tenant context. RLS still applies, so
    // they see zero rows in tenant tables — which is exactly what we want for login.
    if (skipTenant || !principal) {
      return from(
        runWithContext({ ...base, shopId: null, tx: null }, () =>
          firstValueFrom(next.handle() as Observable<unknown>),
        ),
      )
    }

    return from(
      this.prisma.runAsTenant({ ...base, shopId: principal.shopId }, () =>
        firstValueFrom(next.handle() as Observable<unknown>),
      ),
    )
  }
}
