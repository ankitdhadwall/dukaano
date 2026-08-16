import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { ShopRole } from '@dukaano/types'

/**
 * The single call site for the `auth_active_memberships` SECURITY DEFINER function.
 *
 * Every read of `shop_membership` that happens *before* a tenant context exists goes through
 * here — login, token rotation, and the auth guard. Keeping it to one function means the narrow
 * RLS bypass the database function grants has exactly one entry point in the codebase, which is
 * what makes it reviewable. See the migration for why a SECURITY DEFINER function was chosen
 * over dropping RLS or granting BYPASSRLS.
 */
export interface ActiveMembership {
  membershipId: string
  shopId: string
  role: ShopRole
  permissionOverrides: Prisma.JsonValue
  membershipStatus: string
  shopName: string
  shopStatus: string
  shopArchivedAt: Date | null
  shopDefaultLocale: string
  shopTimezone: string
  userStatus: string
}

interface RawRow {
  membership_id: string
  shop_id: string
  role: string
  permission_overrides: Prisma.JsonValue
  membership_status: string
  shop_name: string
  shop_status: string
  shop_archived_at: Date | null
  shop_default_locale: string
  shop_timezone: string
  user_status: string
}

const toMembership = (row: RawRow): ActiveMembership => ({
  membershipId: row.membership_id,
  shopId: row.shop_id,
  role: row.role as ShopRole,
  permissionOverrides: row.permission_overrides,
  membershipStatus: row.membership_status,
  shopName: row.shop_name,
  shopStatus: row.shop_status,
  shopArchivedAt: row.shop_archived_at,
  shopDefaultLocale: row.shop_default_locale,
  shopTimezone: row.shop_timezone,
  userStatus: row.user_status,
})

/** Every active membership for a user, oldest first. */
export async function findActiveMemberships(
  client: PrismaClient,
  userId: string,
): Promise<ActiveMembership[]> {
  const rows = await client.$queryRaw<RawRow[]>`
    SELECT * FROM auth_active_memberships(${userId}::uuid)
  `
  return rows.map(toMembership)
}

/**
 * The membership for one user in one specific shop.
 *
 * Filtered in application code rather than by a second SQL parameter, deliberately: the database
 * function takes a user id and nothing else, so there is no parameter an attacker could
 * manipulate to reach a shop the user does not belong to. Narrowing here operates on a set that
 * is already scoped to the caller.
 */
export async function findMembershipForShop(
  client: PrismaClient,
  userId: string,
  shopId: string,
): Promise<ActiveMembership | null> {
  const memberships = await findActiveMemberships(client, userId)
  return memberships.find((m) => m.shopId === shopId) ?? null
}

/** The user's default shop — the one they joined first. */
export async function findDefaultMembership(
  client: PrismaClient,
  userId: string,
): Promise<ActiveMembership | null> {
  const [first] = await findActiveMemberships(client, userId)
  return first ?? null
}
