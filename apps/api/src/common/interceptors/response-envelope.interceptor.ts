import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Observable, map } from 'rxjs'
import { currentContext } from '../prisma/tenant-context'

export const RAW_RESPONSE_KEY = 'dukaano:rawResponse'

/**
 * Return the handler's value as-is, with no `{ data, meta }` envelope.
 *
 * For file downloads only — the CSV template and the failed-row export. A browser saving a `.csv`
 * must receive CSV bytes, not JSON with CSV inside a string field. Marked explicitly per route so
 * the envelope stays the default and an unenveloped response is always a deliberate choice.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true)

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
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (raw) return next.handle()

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
