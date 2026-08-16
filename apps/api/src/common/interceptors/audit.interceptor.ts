import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Observable, from, switchMap } from 'rxjs'
import { AUDIT_KEY } from '../decorators'
import { AuditService } from '../audit/audit.service'

interface AuditMeta {
  action: string
  entityType: string
}

/**
 * Records an audit row for any route marked with `@Audit()`.
 *
 * Runs *after* the handler and only on success, so a rejected request leaves no audit trail
 * claiming it happened. Because the write joins the same tenant transaction the interceptor
 * opened, it commits atomically with the change it describes.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMeta | undefined>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!meta) return next.handle()

    return next.handle().pipe(
      switchMap((result) =>
        from(
          this.audit
            .record({
              action: meta.action,
              entityType: meta.entityType,
              entityId: extractId(result),
              after: result,
            })
            .then(() => result),
        ),
      ),
    )
  }
}

function extractId(result: unknown): string | null {
  if (result && typeof result === 'object' && 'id' in result) {
    const id = (result as { id: unknown }).id
    return typeof id === 'string' ? id : null
  }
  return null
}
