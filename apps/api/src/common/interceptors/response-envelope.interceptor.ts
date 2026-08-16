import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable, map } from 'rxjs'
import { currentContext } from '../prisma/tenant-context'

/**
 * Wraps every success response as `{ data, meta }` (blueprint §21).
 *
 * Also serializes BigInt. Every money and quantity column is BIGINT, so Prisma hands back
 * JavaScript BigInt values, which `JSON.stringify` throws on outright. Converting here — once,
 * at the boundary — means no service or controller has to remember, and the assertion below
 * means a value too large to survive the round trip fails loudly instead of silently losing
 * precision on its way to a shopkeeper's screen.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data) => ({
        data: serializeBigInts(data),
        meta: { requestId: currentContext()?.requestId ?? null },
      })),
    )
  }
}

/**
 * Recursively convert BigInt to number.
 *
 * Blueprint §15.1 transports money as plain JSON integers, which is safe because paise stay well
 * inside the IEEE-754 safe-integer range (₹90,07,19,92,54,740 before it matters). A value that
 * somehow exceeds it is a bug we want to hear about immediately, not one that quietly rounds.
 */
export function serializeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Value ${value} exceeds the JSON-safe integer range and cannot be sent to a client.`,
      )
    }
    return Number(value)
  }
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(serializeBigInts)

  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = serializeBigInts(nested)
  }
  return out
}
