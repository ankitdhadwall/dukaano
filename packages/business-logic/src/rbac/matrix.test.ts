import { describe, expect, it } from 'vitest'
import { PERMISSIONS, SHOP_ROLES, type Permission } from '@dukaano/types'
import {
  ROLE_CEILING,
  ROLE_DEFAULTS,
  hasPermission,
  isGrantable,
  permissionFingerprint,
  resolveEffectivePermissions,
} from './matrix'

describe('role defaults', () => {
  it('gives the Owner every permission', () => {
    expect(new Set(ROLE_DEFAULTS.OWNER)).toEqual(new Set(PERMISSIONS))
  })

  it('never lists a permission a role cannot hold', () => {
    // A default that is also in the ceiling would be silently stripped — a contradiction in the
    // matrix that would confuse anyone reading it.
    for (const role of SHOP_ROLES) {
      for (const permission of ROLE_DEFAULTS[role]) {
        expect(ROLE_CEILING[role]).not.toContain(permission)
      }
    }
  })

  it('only references permissions that exist in the vocabulary', () => {
    for (const role of SHOP_ROLES) {
      for (const permission of [...ROLE_DEFAULTS[role], ...ROLE_CEILING[role]]) {
        expect(PERMISSIONS).toContain(permission)
      }
    }
  })

  it('gives the Cashier only what a counter operator needs', () => {
    expect([...ROLE_DEFAULTS.CASHIER].sort()).toEqual(['customer.write', 'sale.create'])
  })

  it('withholds cost visibility from the Manager? no — a Manager buys stock, so they see cost', () => {
    expect(ROLE_DEFAULTS.MANAGER).toContain('product.view.cost')
    expect(ROLE_DEFAULTS.MANAGER).not.toContain('report.profit')
  })
})

describe('resolveEffectivePermissions', () => {
  it('returns role defaults when there are no overrides', () => {
    expect(resolveEffectivePermissions('MANAGER')).toEqual(new Set(ROLE_DEFAULTS.MANAGER))
    expect(resolveEffectivePermissions('CASHIER', null)).toEqual(new Set(ROLE_DEFAULTS.CASHIER))
    expect(resolveEffectivePermissions('CASHIER', {})).toEqual(new Set(ROLE_DEFAULTS.CASHIER))
  })

  it('applies grants — the common case of an Owner trusting a cashier with khata collection', () => {
    const permissions = resolveEffectivePermissions('CASHIER', {
      grant: ['customer.payment.receive', 'customer.credit.sell'],
    })
    expect(permissions.has('customer.payment.receive')).toBe(true)
    expect(permissions.has('customer.credit.sell')).toBe(true)
  })

  it('applies revokes — an Owner restricting a manager from cancelling sales', () => {
    const permissions = resolveEffectivePermissions('MANAGER', { revoke: ['sale.cancel'] })
    expect(permissions.has('sale.cancel')).toBe(false)
    expect(permissions.has('sale.return')).toBe(true)
  })

  it('applies revokes after grants when both name the same permission', () => {
    const permissions = resolveEffectivePermissions('CASHIER', {
      grant: ['sale.return'],
      revoke: ['sale.return'],
    })
    expect(permissions.has('sale.return')).toBe(false)
  })
})

describe('the role ceiling — the escalation defence', () => {
  it.each(ROLE_CEILING.CASHIER)(
    'refuses to grant %s to a Cashier even when explicitly asked',
    (permission) => {
      const permissions = resolveEffectivePermissions('CASHIER', { grant: [permission] })
      expect(permissions.has(permission)).toBe(false)
    },
  )

  it('cannot be escaped by granting the entire permission vocabulary', () => {
    // Simulates the worst case: a corrupted JSONB column or a malicious sync payload that
    // sets every permission on a Cashier membership.
    const permissions = resolveEffectivePermissions('CASHIER', { grant: PERMISSIONS })

    for (const forbidden of ROLE_CEILING.CASHIER) {
      expect(permissions.has(forbidden)).toBe(false)
    }
    expect(permissions.has('product.view.cost')).toBe(false)
    expect(permissions.has('customer.ledger.adjust')).toBe(false)
    expect(permissions.has('employee.manage')).toBe(false)
    expect(permissions.has('subscription.manage')).toBe(false)
  })

  it('stops a Manager from reaching subscription management', () => {
    const permissions = resolveEffectivePermissions('MANAGER', { grant: ['subscription.manage'] })
    expect(permissions.has('subscription.manage')).toBe(false)
  })

  it('leaves the Owner unconstrained', () => {
    expect(ROLE_CEILING.OWNER).toEqual([])
    expect(resolveEffectivePermissions('OWNER')).toEqual(new Set(PERMISSIONS))
  })

  it('guarantees a Cashier can never see margins by any route', () => {
    // Enumerated deliberately: this is the permission whose leak costs the shop money directly.
    for (const overrides of [
      { grant: ['product.view.cost' as Permission] },
      { grant: PERMISSIONS },
      { grant: ['product.view.cost' as Permission], revoke: [] },
    ]) {
      expect(hasPermission('CASHIER', 'product.view.cost', overrides)).toBe(false)
    }
  })
})

describe('hasPermission', () => {
  it('answers the guard question directly', () => {
    expect(hasPermission('OWNER', 'subscription.manage')).toBe(true)
    expect(hasPermission('MANAGER', 'subscription.manage')).toBe(false)
    expect(hasPermission('CASHIER', 'sale.create')).toBe(true)
    expect(hasPermission('CASHIER', 'sale.cancel')).toBe(false)
    expect(hasPermission('CASHIER', 'sale.cancel', { grant: ['sale.cancel'] })).toBe(true)
  })
})

describe('isGrantable', () => {
  it('drives the employee-permissions UI: which toggles are even shown', () => {
    expect(isGrantable('CASHIER', 'sale.cancel')).toBe(true)
    expect(isGrantable('CASHIER', 'product.view.cost')).toBe(false)
    expect(isGrantable('MANAGER', 'subscription.manage')).toBe(false)
    expect(isGrantable('OWNER', 'subscription.manage')).toBe(true)
  })
})

describe('permissionFingerprint', () => {
  it('is stable regardless of insertion order', () => {
    const a = permissionFingerprint(new Set<Permission>(['sale.create', 'customer.write']))
    const b = permissionFingerprint(new Set<Permission>(['customer.write', 'sale.create']))
    expect(a).toBe(b)
  })

  it('changes when the permission set changes', () => {
    const before = permissionFingerprint(resolveEffectivePermissions('CASHIER'))
    const after = permissionFingerprint(
      resolveEffectivePermissions('CASHIER', { grant: ['customer.payment.receive'] }),
    )
    expect(after).not.toBe(before)
  })

  it('produces a fixed-width hex string', () => {
    for (const role of SHOP_ROLES) {
      expect(permissionFingerprint(resolveEffectivePermissions(role))).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it('distinguishes all three roles', () => {
    const fingerprints = SHOP_ROLES.map((r) => permissionFingerprint(resolveEffectivePermissions(r)))
    expect(new Set(fingerprints).size).toBe(SHOP_ROLES.length)
  })

  it('handles the empty set', () => {
    expect(permissionFingerprint(new Set())).toMatch(/^[0-9a-f]{8}$/)
  })
})
