import type { Permission, ShopRole } from '@dukaano/types'
import type { Request } from 'express'

/** Claims carried by an access token (blueprint §23.1). Kept small — it travels on every call. */
export interface AccessTokenPayload {
  /** User id. */
  sub: string
  /** The shop this token is scoped to. A user in several shops holds one token per shop (E-36). */
  shopId: string
  role: ShopRole
  /**
   * Fingerprint of the effective permission set. Lets the API detect a token minted before a
   * permission change without a database read on every request, so a change takes effect in
   * seconds rather than at the next 15-minute expiry. Not a security boundary — permissions are
   * still resolved server-side — purely a freshness signal.
   */
  permHash: string
  deviceId?: string
  /** Token id, for revocation. */
  jti: string
}

export interface RequestPrincipal {
  readonly userId: string
  readonly shopId: string
  readonly role: ShopRole
  readonly permissions: ReadonlySet<Permission>
  readonly deviceId: string | null
  readonly membershipId: string
}

export interface AuthenticatedRequest extends Request {
  principal?: RequestPrincipal
  requestId?: string
}
