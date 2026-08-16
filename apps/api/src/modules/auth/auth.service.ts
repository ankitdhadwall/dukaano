import { Injectable } from '@nestjs/common'
import * as argon2 from 'argon2'
import { randomUUID } from 'node:crypto'
import type { LoginInput, RegisterInput } from '@dukaano/validation'
import { DEFAULT_LOCALE } from '@dukaano/types'
import { PrismaService } from '../../common/prisma/prisma.service'
import {
  InvalidCredentialsError,
  PhoneAlreadyRegisteredError,
  UnauthorizedError,
} from '../../common/errors/domain-error'
import { findDefaultMembership } from './membership-lookup'
import { TokenService, type TokenPair } from './token.service'

/**
 * argon2id parameters (blueprint §23.1).
 *
 * 64 MiB / 3 iterations / parallelism 4 is the OWASP-recommended baseline. It costs roughly
 * 50–100 ms per verification on the API tier, which is the point: it makes an offline attack on
 * a leaked password hash economically painful. Reducing memoryCost to speed up login is the
 * classic false economy here and should not be done without an ADR.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
}

export interface AuthResult extends TokenPair {
  readonly user: { id: string; fullName: string; phone: string | null; locale: string }
  readonly shop: { id: string; name: string; defaultLocale: string; timezone: string }
  readonly role: string
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Register a user and create their shop in one atomic step (journey J1).
   *
   * Registration is the one flow that genuinely requires connectivity, and the onboarding copy
   * says so plainly. Everything after it works offline.
   *
   * The tenant transaction is opened here rather than by the interceptor, because the shop this
   * request creates does not exist when the interceptor runs.
   */
  async register(
    input: RegisterInput,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<AuthResult> {
    const existing = await this.prisma.untenanted.user.findUnique({
      where: { phoneE164: input.phone },
      select: { id: true },
    })
    if (existing) throw new PhoneAlreadyRegisteredError()

    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS)
    const locale = input.locale ?? DEFAULT_LOCALE
    const userId = randomUUID()
    const shopId = randomUUID()

    // Every INSERT below supplies shop_id explicitly, but RLS's WITH CHECK compares it against
    // current_setting('app.shop_id') — which is unset here, so the writes would be rejected.
    // withTenant sets the context to the shop being created.
    const { shop } = await this.prisma.withTenant(shopId, async (tx) => {
      const user = await tx.user.create({
        data: {
          id: userId,
          phoneE164: input.phone,
          passwordHash,
          fullName: input.fullName,
          locale,
          status: 'ACTIVE',
        },
      })

      const createdShop = await tx.shop.create({
        data: {
          id: shopId,
          name: input.shopName,
          timezone: input.timezone ?? 'Asia/Kolkata',
          defaultLocale: locale,
          currency: 'INR',
          status: 'TRIAL',
          city: input.city ?? null,
          stateCode: input.stateCode ?? null,
          settings: { create: {} }, // defaults encode the §17.3 / §25 E-20 policy choices
        },
      })

      await tx.shopMembership.create({
        data: {
          id: randomUUID(),
          shopId,
          userId: user.id,
          role: 'OWNER',
          permissionOverrides: {},
          status: 'ACTIVE',
          joinedAt: new Date(),
        },
      })

      return { shop: createdShop }
    })

    const pair = await this.tokens.issue({
      userId,
      shopId,
      role: 'OWNER',
      permissionOverrides: {},
      ...meta,
    })

    return {
      ...pair,
      user: { id: userId, fullName: input.fullName, phone: input.phone, locale },
      shop: {
        id: shop.id,
        name: shop.name,
        defaultLocale: shop.defaultLocale,
        timezone: shop.timezone,
      },
      role: 'OWNER',
    }
  }

  async login(input: LoginInput, meta: { ipAddress?: string; userAgent?: string }): Promise<AuthResult> {
    const user = await this.prisma.untenanted.user.findFirst({
      where: input.phone ? { phoneE164: input.phone } : { email: input.email },
      select: {
        id: true,
        passwordHash: true,
        fullName: true,
        phoneE164: true,
        locale: true,
        status: true,
      },
    })

    /*
     * Verify a dummy hash when the user does not exist.
     *
     * Without this, a missing user returns in ~1 ms while a wrong password takes ~80 ms, and the
     * difference lets an attacker enumerate which mobile numbers have Dukaano accounts. That is
     * a real privacy leak for shopkeepers, not a theoretical one.
     */
    if (!user) {
      await argon2.verify(DUMMY_HASH, input.password).catch(() => false)
      throw new InvalidCredentialsError()
    }

    const passwordValid = await argon2.verify(user.passwordHash, input.password).catch(() => false)
    if (!passwordValid) throw new InvalidCredentialsError()

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedError('errors.auth.accountSuspended', 'Account is not active')
    }

    // shop_membership is RLS-protected and no tenant context exists yet — which shop this user
    // belongs to is exactly what we are trying to discover. See membership-lookup.ts.
    const membership = await findDefaultMembership(this.prisma.untenanted, user.id)

    if (!membership) {
      throw new UnauthorizedError('errors.tenant.noShop', 'No active shop membership')
    }

    const deviceId = await this.upsertDevice(membership.shopId, user.id, input)

    const pair = await this.tokens.issue({
      userId: user.id,
      shopId: membership.shopId,
      role: membership.role,
      permissionOverrides: membership.permissionOverrides,
      deviceId,
      ...meta,
    })

    await this.prisma.untenanted.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })

    return {
      ...pair,
      user: {
        id: user.id,
        fullName: user.fullName,
        phone: user.phoneE164,
        locale: user.locale ?? membership.shopDefaultLocale,
      },
      shop: {
        id: membership.shopId,
        name: membership.shopName,
        defaultLocale: membership.shopDefaultLocale,
        timezone: membership.shopTimezone,
      },
      role: membership.role,
    }
  }

  /**
   * Register or refresh the calling device.
   *
   * The device row is what later lets the Owner see "who is logged in where" and revoke a lost
   * phone, and what the sync engine attaches number leases and its pull cursor to (§14.6).
   */
  private async upsertDevice(
    shopId: string,
    userId: string,
    input: LoginInput,
  ): Promise<string | null> {
    if (!input.deviceId) return null

    await this.prisma.withTenant(shopId, async (tx) => {
      await tx.device.upsert({
        where: { id: input.deviceId },
        create: {
          id: input.deviceId as string,
          shopId,
          userId,
          name: input.deviceName ?? null,
          platform: input.platform ?? 'ANDROID',
          appVersion: input.appVersion ?? null,
          lastSeenAt: new Date(),
        },
        update: {
          userId,
          appVersion: input.appVersion ?? null,
          lastSeenAt: new Date(),
        },
      })
    })

    return input.deviceId
  }
}

/**
 * A real argon2id hash of a value nobody knows, used only to equalise timing on the
 * user-not-found path. Must stay a genuine hash — a short constant would verify too quickly and
 * reintroduce the timing signal it exists to remove.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZTEyMw$3Yl8pMlvGKzKvXQxJ9V8Xk2mZ7nB1cD4eF5gH6iJ7kL'
