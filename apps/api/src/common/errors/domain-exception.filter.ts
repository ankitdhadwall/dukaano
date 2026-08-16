import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Response } from 'express'
import type { ZodIssue } from 'zod'
import { DomainError, ValidationError } from './domain-error'
import { currentContext } from '../prisma/tenant-context'

export interface ErrorResponseBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly messageKey: string
    readonly params?: Record<string, unknown>
    readonly fieldErrors?: Record<string, string[]>
    readonly retryable: boolean
    readonly requestId: string
  }
}

/**
 * The single exit point for every error leaving the API (blueprint §24).
 *
 * Two rules it exists to enforce:
 *
 *   1. **Errors are never swallowed.** Everything that reaches here is either mapped to a typed
 *      response or logged as an unexpected exception with its stack. Nothing disappears.
 *   2. **Expected domain errors do NOT go to Sentry.** Insufficient stock and duplicate SKUs are
 *      business outcomes, not defects. Reporting them would bury real exceptions under thousands
 *      of routine events until nobody reads the error feed at all (§24.2).
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    const requestId = currentContext()?.requestId ?? 'unknown'

    const { status, body } = this.toResponse(exception, requestId)

    // Only genuinely unexpected failures are logged at error level with a stack.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { requestId, code: body.error.code, err: exception },
        `Unhandled exception: ${body.error.message}`,
      )
    } else {
      this.logger.debug({ requestId, code: body.error.code }, body.error.message)
    }

    response.status(status).json(body)
  }

  private toResponse(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ErrorResponseBody } {
    // 1. Our own taxonomy — the expected path.
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            messageKey: exception.messageKey,
            ...(Object.keys(exception.params).length > 0 ? { params: exception.params } : {}),
            ...(exception instanceof ValidationError
              ? { fieldErrors: exception.fieldErrors }
              : {}),
            retryable: exception.retryable,
            requestId,
          },
        },
      }
    }

    // 2. Zod failures from a DTO pipe. Field errors carry i18n keys as their messages, because
    //    the schemas in @dukaano/validation are written that way.
    const zodIssues = asZodIssues(exception)
    if (zodIssues) {
      const fieldErrors: Record<string, string[]> = {}
      for (const issue of zodIssues) {
        const path = issue.path.join('.') || '_root'
        ;(fieldErrors[path] ??= []).push(issue.message)
      }
      return this.toResponse(new ValidationError(fieldErrors), requestId)
    }

    // 3. Prisma. Mapped explicitly so a database detail never reaches the client.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaError(exception, requestId)
    }

    // 4. Nest's own HttpExceptions (thrown by guards, throttler, and 404 routing).
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      return {
        status,
        body: {
          error: {
            code: status === HttpStatus.TOO_MANY_REQUESTS ? 'RATE_LIMITED' : 'HTTP_ERROR',
            message: exception.message,
            messageKey:
              status === HttpStatus.TOO_MANY_REQUESTS
                ? 'errors.rateLimited'
                : status === HttpStatus.NOT_FOUND
                  ? 'errors.notFound'
                  : 'errors.unknown',
            retryable: status === HttpStatus.TOO_MANY_REQUESTS,
            requestId,
          },
        },
      }
    }

    // 5. Anything else is a real bug. Return a generic message — an internal error string can
    //    leak a table name, a file path or a query fragment.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: exception instanceof Error ? exception.message : 'Unknown error',
          messageKey: 'errors.unknown',
          retryable: false,
          requestId,
        },
      },
    }
  }

  private mapPrismaError(
    exception: Prisma.PrismaClientKnownRequestError,
    requestId: string,
  ): { status: number; body: ErrorResponseBody } {
    const generic = (
      status: number,
      code: string,
      messageKey: string,
    ): { status: number; body: ErrorResponseBody } => ({
      status,
      body: {
        error: { code, message: exception.message, messageKey, retryable: false, requestId },
      },
    })

    switch (exception.code) {
      case 'P2002': // unique constraint
        return generic(HttpStatus.CONFLICT, 'DUPLICATE', 'errors.validation')
      case 'P2003': // FK violation — in a composite-FK schema this usually means cross-tenant
        return generic(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'errors.notFound')
      case 'P2025': // record not found
        return generic(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'errors.notFound')
      default:
        return generic(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'DATABASE_ERROR',
          'errors.unknown',
        )
    }
  }
}

/**
 * Detect a ZodError structurally rather than with `instanceof`.
 *
 * The schemas live in @dukaano/validation, which carries its own `zod` dependency. Under pnpm's
 * strict node_modules layout that can resolve to a *different module instance* than the one
 * apps/api imports, and `instanceof` across two copies of a class is false. The failure mode is
 * nasty: every validation error becomes a 500 with a generic message, so a shopkeeper who typed a
 * bad phone number is told "something went wrong" instead of which field to fix.
 *
 * Duck-typing on the documented `issues` shape is immune to that, and to a future zod major
 * version being bumped in only one package.
 */
function asZodIssues(exception: unknown): ZodIssue[] | null {
  if (!exception || typeof exception !== 'object') return null
  if ((exception as { name?: unknown }).name !== 'ZodError') return null

  const issues = (exception as { issues?: unknown }).issues
  return Array.isArray(issues) ? (issues as ZodIssue[]) : null
}
