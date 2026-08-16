import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { permissionFingerprint, resolveEffectivePermissions } from '@dukaano/business-logic'
import type { ShopRole } from '@dukaano/types'
import { env } from '../../config/env'
import { PrismaService } from '../../common/prisma/prisma.service'
import { RefreshTokenReusedError, UnauthorizedError } from '../../common/errors/domain-error'
import { findDefaultMembership } from './membership-lookup'
import type { AccessTokenPayload } from '../../common/guards/types'

export interface TokenPair {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresIn: number
}

/**
 * Token issuance and rotation (blueprint §23.1).
 *
 * The design decision that matters here is **refresh-token rotation with reuse detection**:
 *
 *   • The refresh token is opaque random bytes, not a JWT — it carries no claims, so it cannot
 *     be used as an access token even if the two secrets were ever confused.
 *   • Only its SHA-256 hash is stored. A database dump does not yield usable tokens.
 *   • Every use issues a new token and revokes the old one.
 *   • Presenting an already-rotated token revokes the **entire family**, logging every device in
 *     that lineage out.
 *
 * That last rule is what makes theft survivable. If an attacker copies a refresh token, one of
 * the two parties will eventually present the stale one, and the family dies. Without it, a
 * stolen token grants 60 days of silent access. This matters more for Dukaano than for typical
 * B2B software: these are shared counter phones that get lost, sold and handed to relatives.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000)
  }

  /** Issue a fresh pair and open a new token family. */
  async issue(params: {
    userId: string
    shopId: string
    role: ShopRole
    permissionOverrides: unknown
    deviceId?: string | null
    ipAddress?: string
    userAgent?: string
  }): Promise<TokenPair> {
    return this.mint({ ...params, familyId: randomUUID() })
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * Ordering is load-bearing: the reuse check happens before anything is issued, and the
   * family-wide revocation happens before the error is thrown, so a race between two concurrent
   * refreshes still ends with the family closed.
   */
  async rotate(
    refreshToken: string,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<TokenPair> {
    const tokenHash = this.hash(refreshToken)

    const session = await this.prisma.untenanted.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        deviceId: true,
        expiresAt: true,
        revokedAt: true,
      },
    })

    if (!session) {
      throw new UnauthorizedError('errors.auth.sessionExpired', 'Unknown refresh token')
    }

    if (session.revokedAt) {
      // Already rotated. Either the token was stolen and replayed, or a buggy client retried.
      // We cannot tell which, so we assume theft — the cost of being wrong is one extra login,
      // and the cost of guessing the other way is an attacker with a live session.
      await this.revokeFamily(session.familyId, 'REFRESH_TOKEN_REUSE')
      throw new RefreshTokenReusedError()
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('errors.auth.sessionExpired', 'Refresh token expired')
    }

    const membership = await findDefaultMembership(this.prisma.untenanted, session.userId)
    if (!membership) {
      throw new UnauthorizedError('errors.tenant.noShop', 'No active membership')
    }

    // Revoke the presented token first, so a concurrent replay of the same token hits the
    // reuse branch above rather than succeeding twice.
    await this.prisma.untenanted.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: 'ROTATED', lastUsedAt: new Date() },
    })

    return this.mint({
      userId: session.userId,
      shopId: membership.shopId,
      role: membership.role,
      permissionOverrides: membership.permissionOverrides,
      deviceId: session.deviceId,
      familyId: session.familyId,
      ...meta,
    })
  }

  /** Revoke one session (logout on this device). */
  async revoke(refreshToken: string): Promise<void> {
    await this.prisma.untenanted.session.updateMany({
      where: { tokenHash: this.hash(refreshToken), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    })
  }

  /** Revoke an entire lineage (reuse detected, password changed, device revoked). */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.untenanted.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    })
  }

  /** Revoke every session for a user (password change, account suspension). */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.prisma.untenanted.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    })
  }

  private async mint(params: {
    userId: string
    shopId: string
    role: ShopRole
    permissionOverrides: unknown
    deviceId?: string | null
    familyId: string
    ipAddress?: string
    userAgent?: string
  }): Promise<TokenPair> {
    const permissions = resolveEffectivePermissions(
      params.role,
      params.permissionOverrides as never,
    )

    const payload: AccessTokenPayload = {
      sub: params.userId,
      shopId: params.shopId,
      role: params.role,
      permHash: permissionFingerprint(permissions),
      jti: randomUUID(),
      ...(params.deviceId ? { deviceId: params.deviceId } : {}),
    }

    const accessToken = await this.jwt.signAsync(payload, {
      secret: env.JWT_ACCESS_SECRET,
      expiresIn: env.JWT_ACCESS_TTL_SECONDS,
    })

    // 256 bits of entropy, opaque. Never a JWT: a refresh token must not be usable as anything
    // other than a lookup key.
    const refreshToken = randomBytes(32).toString('base64url')

    await this.prisma.untenanted.session.create({
      data: {
        id: randomUUID(),
        userId: params.userId,
        deviceId: params.deviceId ?? null,
        tokenHash: this.hash(refreshToken),
        familyId: params.familyId,
        expiresAt: this.refreshExpiry(),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent?.slice(0, 500) ?? null,
      },
    })

    return { accessToken, refreshToken, expiresIn: env.JWT_ACCESS_TTL_SECONDS }
  }
}
