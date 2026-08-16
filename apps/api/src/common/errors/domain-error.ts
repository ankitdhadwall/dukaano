import { HttpStatus } from '@nestjs/common'

/**
 * The Dukaano error taxonomy (blueprint §24.1).
 *
 * Five classes, each with a fixed handling contract. Every error carries an **i18n key**, never
 * prose: the server returns the key and the client renders it in the reader's language. A server
 * that returns English text makes Hindi a second-class experience the moment anything goes wrong
 * — which is exactly when a shopkeeper most needs to understand what happened.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string
  abstract readonly httpStatus: HttpStatus
  /** i18n key resolved by the client, e.g. `errors.inventory.insufficient`. */
  abstract readonly messageKey: string
  /** Interpolation values for the key. Must never contain PII — this crosses the wire and is logged. */
  readonly params: Record<string, unknown>
  /** Whether a client may safely retry the identical request. */
  readonly retryable: boolean = false

  protected constructor(message: string, params: Record<string, unknown> = {}) {
    super(message)
    this.name = new.target.name
    this.params = params
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** 400 — malformed input. The client highlights the field. */
export class ValidationError extends DomainError {
  override readonly code = 'VALIDATION_FAILED'
  override readonly httpStatus = HttpStatus.BAD_REQUEST
  override readonly messageKey = 'errors.validation'

  constructor(readonly fieldErrors: Record<string, string[]>) {
    super('Request validation failed')
  }
}

/**
 * 403 — authenticated, but not allowed.
 *
 * Names the missing permission and who can grant it. A bare "Forbidden" tells a cashier nothing
 * actionable; "You do not have permission to cancel a sale. Ask the shop owner to enable it."
 * tells them exactly what to do next.
 */
export class PermissionDeniedError extends DomainError {
  override readonly code = 'PERMISSION_DENIED'
  override readonly httpStatus = HttpStatus.FORBIDDEN
  override readonly messageKey = 'errors.permission.denied'

  constructor(readonly permission: string) {
    super(`Missing permission: ${permission}`, { action: permission })
  }
}

/** 403 — the shop's plan does not include this feature. Distinct from a permission problem. */
export class EntitlementDeniedError extends DomainError {
  override readonly code = 'ENTITLEMENT_DENIED'
  override readonly httpStatus = HttpStatus.FORBIDDEN
  override readonly messageKey = 'errors.entitlement.denied'

  constructor(
    readonly entitlement: string,
    planName: string,
  ) {
    super(`Plan does not include: ${entitlement}`, { plan: planName })
  }
}

/**
 * 404 — absent, or belonging to another shop.
 *
 * Blueprint §23.3: cross-tenant access returns **404, never 403**. A 403 would confirm the
 * resource exists, letting an attacker enumerate other shops' sale and customer ids. The two
 * cases are deliberately indistinguishable from outside.
 */
export class NotFoundError extends DomainError {
  override readonly code = 'NOT_FOUND'
  override readonly httpStatus = HttpStatus.NOT_FOUND
  override readonly messageKey = 'errors.notFound'

  constructor(entity: string, id?: string) {
    super(`${entity} not found${id ? `: ${id}` : ''}`)
  }
}

/** 401 — not authenticated, or the session ended. */
export class UnauthorizedError extends DomainError {
  override readonly code = 'UNAUTHORIZED'
  override readonly httpStatus = HttpStatus.UNAUTHORIZED

  constructor(
    override readonly messageKey: string = 'errors.auth.sessionExpired',
    message = 'Unauthorized',
  ) {
    super(message)
  }
}

/**
 * 422 — the input is well-formed but a business rule says no.
 *
 * The client shows the rule in plain language plus the available action. This is the class that
 * carries insufficient stock, an over-limit customer, archiving a customer who still owes money.
 */
export class BusinessRuleError extends DomainError {
  override readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY

  constructor(
    override readonly code: string,
    override readonly messageKey: string,
    params: Record<string, unknown> = {},
    message?: string,
  ) {
    super(message ?? code, params)
  }
}

/** 409 — a uniqueness or concurrency conflict the client can resolve. */
export class ConflictError extends DomainError {
  override readonly httpStatus = HttpStatus.CONFLICT

  constructor(
    override readonly code: string,
    override readonly messageKey: string,
    params: Record<string, unknown> = {},
  ) {
    super(code, params)
  }
}

/** 503 — a dependency failed. The only class that is retryable by default. */
export class InfrastructureError extends DomainError {
  override readonly code = 'INFRASTRUCTURE_ERROR'
  override readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE
  override readonly messageKey = 'errors.unknown'
  override readonly retryable = true

  constructor(
    readonly dependency: string,
    override readonly cause?: unknown,
  ) {
    super(`Dependency unavailable: ${dependency}`)
  }
}

// --- Concrete business rules used in Phase 1 -------------------------------------------------

export class PhoneAlreadyRegisteredError extends ConflictError {
  constructor() {
    super('PHONE_TAKEN', 'errors.auth.phoneTaken')
  }
}

export class InvalidCredentialsError extends UnauthorizedError {
  constructor() {
    super('errors.auth.invalidCredentials', 'Invalid credentials')
  }
}

/**
 * Raised when a rotated refresh token is presented a second time (blueprint §23.1).
 *
 * Token reuse means either a stolen token or a buggy client. We cannot tell which, so we assume
 * theft and revoke the entire token family. These devices get lost and shared between family
 * members, which makes this defence load-bearing rather than theoretical.
 */
export class RefreshTokenReusedError extends UnauthorizedError {
  constructor() {
    super('errors.auth.tokenReused', 'Refresh token reuse detected; token family revoked')
  }
}

export class NoShopMembershipError extends DomainError {
  override readonly code = 'NO_SHOP_MEMBERSHIP'
  override readonly httpStatus = HttpStatus.FORBIDDEN
  override readonly messageKey = 'errors.tenant.noShop'

  constructor() {
    super('User is not an active member of any shop')
  }
}
