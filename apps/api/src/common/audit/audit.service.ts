import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { currentContext } from '../prisma/tenant-context'

export interface AuditEntry {
  readonly action: string
  readonly entityType: string
  readonly entityId?: string | null
  readonly before?: unknown
  readonly after?: unknown
}

/**
 * Audit trail (blueprint §28).
 *
 * Two properties matter more than completeness:
 *
 *   1. **Writes inside the request transaction.** An audit row that commits while the change it
 *      describes rolls back is worse than no audit row — it asserts something happened that did
 *      not. Using the request's tenant transaction makes the two atomic.
 *   2. **Redaction before write.** Audit rows are read by support staff and exported. Password
 *      hashes, tokens and full phone numbers must never land in `before`/`after` (§23.4, §43).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name)

  async record(entry: AuditEntry): Promise<void> {
    const context = currentContext()
    if (!context?.tx || !context.shopId) {
      // Never throw from the audit path — losing an audit row must not fail a shopkeeper's sale.
      // But never silently drop it either: it is logged so the gap is visible in the error feed.
      this.logger.warn(`Audit entry dropped (no tenant transaction): ${entry.action}`)
      return
    }

    await context.tx.auditLog.create({
      data: {
        id: randomUUID(),
        shopId: context.shopId,
        actorType: 'USER',
        actorUserId: context.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: redact(entry.before) as never,
        after: redact(entry.after) as never,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent?.slice(0, 500) ?? null,
        requestId: context.requestId,
      },
    })
  }
}

/**
 * Field names whose values never appear in an audit row, regardless of nesting depth.
 *
 * An allowlist would be safer still, but it would silently drop new business fields and make the
 * audit trail useless for its actual purpose. A denylist of credential-shaped names is the right
 * trade here, and it is asserted by a test.
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'temporaryPassword',
  'token',
  'tokenHash',
  'refreshToken',
  'accessToken',
  'otp',
  'secret',
  'phoneE164',
  'phone_e164',
  'phone',
])

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return Number(value)
  if (Array.isArray(value)) return value.map(redact)

  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : typeof nested === 'bigint' ? Number(nested) : redact(nested)
  }
  return out
}
