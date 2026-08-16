import { Injectable } from '@nestjs/common'
import * as argon2 from 'argon2'
import { randomUUID } from 'node:crypto'
import { isGrantable, resolveEffectivePermissions } from '@dukaano/business-logic'
import type { Permission, ShopRole } from '@dukaano/types'
import type { InviteMemberInput, UpdateMembershipInput } from '@dukaano/validation'
import { BusinessRuleError, ConflictError, NotFoundError } from '../../common/errors/domain-error'
import { PrismaService } from '../../common/prisma/prisma.service'
import { tenantClient } from '../../common/prisma/tenant-context'

/**
 * Shop staff management (blueprint §9, §22).
 *
 * The rule this service exists to enforce is the **role ceiling**: an Owner may grant a Cashier
 * extra permissions, but never one that is forbidden at that role. `resolveEffectivePermissions`
 * would silently strip a forbidden grant anyway, which is safe but confusing — the Owner would
 * toggle a switch and see nothing happen. So we reject the request explicitly and say why.
 */
@Injectable()
export class MembershipsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(shopId: string) {
    const memberships = await tenantClient().shopMembership.findMany({
      where: { shopId, status: { not: 'REMOVED' } },
      select: {
        id: true,
        role: true,
        status: true,
        permissionOverrides: true,
        joinedAt: true,
        user: { select: { id: true, fullName: true, phoneE164: true, lastLoginAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    return memberships.map((m) => ({
      ...m,
      effectivePermissions: [
        ...resolveEffectivePermissions(m.role as ShopRole, m.permissionOverrides as never),
      ].sort(),
    }))
  }

  /**
   * Invite a staff member.
   *
   * MVP uses a temporary password the Owner reads out, because OTP requires TRAI DLT
   * registration which is not on the MVP critical path (§20.5, §5.2). The account is created
   * immediately so the cashier can log in at the counter without waiting for anything.
   */
  async invite(shopId: string, invitedByUserId: string, input: InviteMemberInput) {
    const passwordHash = await argon2.hash(input.temporaryPassword, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 4,
    })

    // The user table is cross-tenant, so this lookup is untenanted by necessity: the same person
    // may already work at another shop (E-36), and we attach a membership rather than duplicating.
    const existingUser = await this.prisma.untenanted.user.findUnique({
      where: { phoneE164: input.phone },
      select: { id: true },
    })

    const userId = existingUser?.id ?? randomUUID()

    if (!existingUser) {
      await this.prisma.untenanted.user.create({
        data: {
          id: userId,
          phoneE164: input.phone,
          passwordHash,
          fullName: input.fullName,
          status: 'ACTIVE',
        },
      })
    }

    const duplicate = await tenantClient().shopMembership.findFirst({
      where: { shopId, userId },
      select: { id: true, status: true },
    })
    if (duplicate && duplicate.status !== 'REMOVED') {
      throw new ConflictError('MEMBER_EXISTS', 'errors.member.alreadyExists')
    }

    return tenantClient().shopMembership.create({
      data: {
        id: randomUUID(),
        shopId,
        userId,
        role: input.role,
        permissionOverrides: {},
        status: 'ACTIVE',
        invitedByUserId,
        joinedAt: new Date(),
      },
      select: { id: true, role: true, status: true, userId: true },
    })
  }

  async update(shopId: string, membershipId: string, actorUserId: string, input: UpdateMembershipInput) {
    const membership = await tenantClient().shopMembership.findFirst({
      where: { id: membershipId, shopId },
      select: { id: true, role: true, userId: true },
    })
    if (!membership) throw new NotFoundError('ShopMembership', membershipId)

    const nextRole = (input.role ?? membership.role) as ShopRole

    /*
     * An Owner may not demote or suspend themselves.
     *
     * Without this a shop can be left with no Owner at all — no one able to manage staff, change
     * settings or handle the subscription — recoverable only by us touching their database.
     */
    if (membership.userId === actorUserId && (input.role || input.status)) {
      throw new BusinessRuleError(
        'CANNOT_MODIFY_SELF',
        'errors.member.cannotModifySelf',
        {},
        'A user cannot change their own role or status',
      )
    }

    if (input.permissionOverrides?.grant) {
      const forbidden = input.permissionOverrides.grant.filter(
        (permission: Permission) => !isGrantable(nextRole, permission),
      )
      if (forbidden.length > 0) {
        // Reject rather than silently strip: an Owner who flips a switch and sees nothing change
        // concludes the product is broken.
        throw new BusinessRuleError(
          'PERMISSION_NOT_GRANTABLE',
          'errors.member.permissionNotGrantable',
          { role: nextRole, permissions: forbidden.join(', ') },
          `These permissions can never be granted to ${nextRole}: ${forbidden.join(', ')}`,
        )
      }
    }

    return tenantClient().shopMembership.update({
      where: { id: membershipId },
      data: {
        role: input.role ?? undefined,
        status: input.status ?? undefined,
        permissionOverrides: input.permissionOverrides ?? undefined,
      },
      select: { id: true, role: true, status: true, permissionOverrides: true },
    })
  }
}
