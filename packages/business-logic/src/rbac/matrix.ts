import {
  PERMISSIONS,
  SHOP_ROLES,
  type Permission,
  type PermissionOverrides,
  type ShopRole,
} from '@dukaano/types'

/**
 * The Dukaano role matrix (blueprint §9).
 *
 * Read this table against the one in the blueprint — they must agree, and a test asserts the
 * shape so drift is caught rather than discovered by a shopkeeper.
 *
 *   ✅ default on   ⬜ default off, Owner may grant   ❌ never grantable at this role
 */

/** Permissions each role holds without any override. */
export const ROLE_DEFAULTS: Readonly<Record<ShopRole, readonly Permission[]>> = {
  OWNER: PERMISSIONS,

  MANAGER: [
    'sale.create',
    'sale.view.all',
    'sale.cancel',
    'sale.return',
    'sale.discount',
    'product.view.cost',
    'product.write',
    'product.price.write',
    'product.archive',
    'product.import',
    'inventory.adjust',
    'inventory.stocktake',
    'customer.write',
    'customer.credit.sell',
    'customer.payment.receive',
    'customer.remind',
    'purchase.manage',
    'supplier.manage',
    'report.sales',
  ],

  CASHIER: ['sale.create', 'customer.write'],
} as const

/**
 * Permissions a role may NEVER hold, even through an explicit grant.
 *
 * This is the hard ceiling from blueprint §9.1 and it is applied **last and server-side**, after
 * role defaults and after per-membership overrides. It exists because `permission_overrides` is
 * a JSONB column: it can be corrupted by a bad migration, a buggy admin screen, or a malicious
 * sync payload. Without a ceiling applied at the end, any of those becomes privilege escalation.
 *
 * The Cashier ceiling is the one that carries real money risk — a cashier who can see purchase
 * cost knows the shop's margins, and one who can adjust the ledger can erase their own theft.
 */
export const ROLE_CEILING: Readonly<Record<ShopRole, readonly Permission[]>> = {
  OWNER: [],

  MANAGER: ['subscription.manage'],

  CASHIER: [
    'product.view.cost',
    'customer.ledger.adjust',
    'customer.archive',
    'report.profit',
    'employee.manage',
    'settings.manage',
    'messaging.manage',
    'subscription.manage',
    'data.export',
    'audit.view',
    'device.revoke',
  ],
} as const

/**
 * Resolve the effective permission set for a membership.
 *
 * Order is load-bearing:
 *   1. role defaults
 *   2. + explicit grants
 *   3. − explicit revokes
 *   4. − role ceiling      ← last, so nothing above can escalate past it
 *
 * Returns a Set for O(1) checks on the request path.
 */
export function resolveEffectivePermissions(
  role: ShopRole,
  overrides?: PermissionOverrides | null,
): ReadonlySet<Permission> {
  const effective = new Set<Permission>(ROLE_DEFAULTS[role])

  for (const permission of overrides?.grant ?? []) effective.add(permission)
  for (const permission of overrides?.revoke ?? []) effective.delete(permission)
  for (const permission of ROLE_CEILING[role]) effective.delete(permission)

  return effective
}

/** Does this membership hold this permission? The single check used by the API's guard. */
export function hasPermission(
  role: ShopRole,
  permission: Permission,
  overrides?: PermissionOverrides | null,
): boolean {
  return resolveEffectivePermissions(role, overrides).has(permission)
}

/** Could this role ever hold this permission, if an Owner granted it? Drives the UI toggles. */
export function isGrantable(role: ShopRole, permission: Permission): boolean {
  return !ROLE_CEILING[role].includes(permission)
}

/**
 * A stable fingerprint of an effective permission set, embedded in the access token as
 * `perm_hash`.
 *
 * Lets the API detect that a token was minted before a permission change without a database
 * read on every request: if the hash in the token no longer matches the membership's current
 * hash, the token is stale and the client must refresh. Not a security boundary — permissions
 * are still re-checked server-side — but it is what makes a permission change take effect within
 * seconds instead of at the next 15-minute token expiry.
 *
 * FNV-1a: not cryptographic, and does not need to be. It needs to be fast, deterministic across
 * Node and Hermes, and dependency-free.
 */
export function permissionFingerprint(permissions: ReadonlySet<Permission>): string {
  const canonical = [...permissions].sort().join(',')
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Every role, for iteration in tests and admin UIs. */
export const ALL_ROLES = SHOP_ROLES
