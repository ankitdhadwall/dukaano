import { Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { CommonModule } from './common/common.module'
import { AuthModule } from './modules/auth/auth.module'
import { ShopsModule } from './modules/shops/shops.module'
import { MembershipsModule } from './modules/memberships/memberships.module'
import { HealthController } from './health.controller'
import { AuthGuard } from './common/guards/auth.guard'
import { DomainExceptionFilter } from './common/errors/domain-exception.filter'
import { TenantTransactionInterceptor } from './common/interceptors/tenant-transaction.interceptor'
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor'
import { AuditInterceptor } from './common/interceptors/audit.interceptor'

/**
 * The request pipeline (blueprint §12), assembled here in the order it executes:
 *
 *   ThrottlerGuard  → AuthGuard  → TenantTransactionInterceptor → AuditInterceptor
 *                                → handler → ResponseEnvelopeInterceptor → DomainExceptionFilter
 *
 * The ordering is not incidental:
 *   • Throttling precedes authentication so an unauthenticated flood is cheap to reject.
 *   • AuthGuard precedes the tenant interceptor because the shop id comes from the principal.
 *   • The audit interceptor is nested INSIDE the tenant transaction, so an audit row and the
 *     change it records commit or roll back together.
 *   • Nest applies interceptors' response phase in reverse, so the envelope wraps last.
 */
@Module({
  imports: [
    // Enables route-table introspection. Two CI gates depend on it (test/route-table.ts):
    // tenant-isolation coverage, and the default-deny check that every route declares its
    // authorization. Reading Nest's metadata rather than Express internals keeps both gates
    // stable across framework upgrades.
    DiscoveryModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    CommonModule,
    AuthModule,
    ShopsModule,
    MembershipsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
