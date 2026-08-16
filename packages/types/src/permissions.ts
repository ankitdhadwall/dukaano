/**
 * The permission vocabulary (blueprint §9.2).
 *
 * Vocabulary lives here; the role matrix and resolution logic live in
 * @dukaano/business-logic/rbac, which depends on this. The split is deliberate — validation
 * schemas and API decorators need the *names* without pulling in the resolution rules.
 *
 * Blueprint DECISION: roles are a code-defined matrix, not database rows. Three roles and a
 * fixed vocabulary do not justify a DB-driven RBAC engine, and a matrix in source is reviewable
 * in a diff and unit-testable per route — which a table of rows is not.
 */

export const PERMISSIONS = [
  // Sales
  'sale.create',
  'sale.view.all',
  'sale.cancel',
  'sale.return',
  'sale.discount',

  // Catalogue
  'product.view.cost',
  'product.write',
  'product.price.write',
  'product.archive',
  'product.import',

  // Inventory
  'inventory.adjust',
  'inventory.stocktake',

  // Customers & khata
  'customer.write',
  'customer.credit.sell',
  'customer.payment.receive',
  'customer.ledger.adjust',
  'customer.remind',
  'customer.archive',

  // Supply
  'purchase.manage',
  'supplier.manage',

  // Reports
  'report.sales',
  'report.profit',

  // Administration
  'employee.manage',
  'settings.manage',
  'messaging.manage',
  'subscription.manage',
  'data.export',
  'audit.view',
  'device.revoke',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** Runtime guard for values arriving from a JWT claim, a DB JSONB column or a sync payload. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

/**
 * Per-membership grants and revokes, stored as JSONB on `shop_membership`.
 *
 * These layer on top of the role defaults. The role *ceiling* is applied after both, server-side,
 * so a corrupted or hand-edited override can never escalate a Cashier into seeing purchase
 * margins or managing employees.
 */
export interface PermissionOverrides {
  readonly grant?: readonly Permission[]
  readonly revoke?: readonly Permission[]
}

/**
 * Human-readable grouping, used by the employee permissions screen so the Owner sees related
 * toggles together rather than an alphabetical wall of 29 switches.
 */
export const PERMISSION_GROUPS: Readonly<Record<string, readonly Permission[]>> = {
  sales: ['sale.create', 'sale.view.all', 'sale.cancel', 'sale.return', 'sale.discount'],
  catalogue: [
    'product.view.cost',
    'product.write',
    'product.price.write',
    'product.archive',
    'product.import',
  ],
  inventory: ['inventory.adjust', 'inventory.stocktake'],
  customers: [
    'customer.write',
    'customer.credit.sell',
    'customer.payment.receive',
    'customer.ledger.adjust',
    'customer.remind',
    'customer.archive',
  ],
  supply: ['purchase.manage', 'supplier.manage'],
  reports: ['report.sales', 'report.profit'],
  administration: [
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
 * Plan entitlements (blueprint §32). Checked *independently* of permissions: a request needs
 * both. An Owner has `report.profit` by role but still cannot open the report if their plan
 * does not entitle `advanced_reports`.
 */
export const ENTITLEMENTS = [
  'unlimited_sales',
  'advanced_reports',
  'multi_device',
  'staff_accounts',
  'bulk_import',
  'data_export',
  'server_messaging',
  'priority_support',
] as const

export type Entitlement = (typeof ENTITLEMENTS)[number]

export function isEntitlement(value: unknown): value is Entitlement {
  return typeof value === 'string' && (ENTITLEMENTS as readonly string[]).includes(value)
}
