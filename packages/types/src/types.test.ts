import { describe, expect, it } from 'vitest'
import {
  ENTITLEMENTS,
  INVENTORY_TRANSACTION_TYPES,
  LEDGER_ENTRY_TYPES,
  PAYMENT_METHODS,
  PERMISSIONS,
  PERMISSION_GROUPS,
  UNIT_DEFINITIONS,
  asId,
  isEntitlement,
  isPermission,
  isUuid,
  parseId,
  type Permission,
} from './index'

describe('runtime guards', () => {
  it('validates permissions arriving from a JWT claim or JSONB column', () => {
    expect(isPermission('sale.create')).toBe(true)
    expect(isPermission('sale.delete')).toBe(false)
    expect(isPermission(null)).toBe(false)
    expect(isPermission(42)).toBe(false)
  })

  it('validates entitlements', () => {
    expect(isEntitlement('advanced_reports')).toBe(true)
    expect(isEntitlement('unicorns')).toBe(false)
    expect(isEntitlement(undefined)).toBe(false)
  })

  it('validates UUIDs', () => {
    expect(isUuid('018f4c1e-1f2a-7c3d-8e4f-5a6b7c8d9e0f')).toBe(true)
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true)
    expect(isUuid('{018f4c1e-1f2a-7c3d-8e4f-5a6b7c8d9e0f}')).toBe(false)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid(123)).toBe(false)
  })

  it('parses a trusted id and rejects an untrusted one', () => {
    const raw = '018f4c1e-1f2a-7c3d-8e4f-5a6b7c8d9e0f'
    expect(parseId(raw, 'Sale')).toBe(raw)
    expect(asId(raw)).toBe(raw)
    expect(() => parseId('nope', 'Sale')).toThrow(/Sale/)
  })
})

describe('domain vocabulary consistency', () => {
  it('has no duplicate permission strings', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length)
  })

  it('groups every permission exactly once, so the employee screen shows all of them', () => {
    const grouped = Object.values(PERMISSION_GROUPS).flat()
    expect(new Set(grouped).size).toBe(grouped.length)
    expect([...grouped].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('has no duplicate entitlements', () => {
    expect(new Set(ENTITLEMENTS).size).toBe(ENTITLEMENTS.length)
  })

  it('does NOT list udhaar as a payment method (blueprint §19.1, binding)', () => {
    // Adding 'UDHAAR' here is the single most likely way to reintroduce the double-counting bug
    // the ledger design exists to prevent: credit would be recorded as money received.
    expect(PAYMENT_METHODS).not.toContain('UDHAAR')
    expect(PAYMENT_METHODS).not.toContain('CREDIT')
  })

  it('requires a reason on exactly the stock movements a shopkeeper must justify', () => {
    const requiring = Object.entries(INVENTORY_TRANSACTION_TYPES)
      .filter(([, meta]) => meta.requiresReason)
      .map(([type]) => type)
      .sort()
    expect(requiring).toEqual(['ADJUSTMENT', 'CORRECTION', 'DAMAGE', 'WASTAGE'])
  })

  it('lets only ADJUSTMENT and CORRECTION move stock in either direction', () => {
    const bidirectional = Object.entries(INVENTORY_TRANSACTION_TYPES)
      .filter(([, meta]) => meta.sign === 'ANY')
      .map(([type]) => type)
      .sort()
    expect(bidirectional).toEqual(['ADJUSTMENT', 'CORRECTION'])
    // …and both of those are exactly the ones that require a reason.
    for (const type of bidirectional) {
      expect(INVENTORY_TRANSACTION_TYPES[type as keyof typeof INVENTORY_TRANSACTION_TYPES].requiresReason).toBe(true)
    }
  })

  it('assigns every ledger entry type a balance direction', () => {
    for (const [type, meta] of Object.entries(LEDGER_ENTRY_TYPES)) {
      expect(['DEBIT', 'CREDIT'], `${type} has no direction`).toContain(meta.sign)
    }
  })

  it('models a sale as a debit and a payment as a credit — getting this backwards inverts every khata', () => {
    expect(LEDGER_ENTRY_TYPES.SALE_CREDIT.sign).toBe('DEBIT')
    expect(LEDGER_ENTRY_TYPES.PAYMENT_RECEIVED.sign).toBe('CREDIT')
    expect(LEDGER_ENTRY_TYPES.SALE_CANCELLED.sign).toBe('CREDIT')
    expect(LEDGER_ENTRY_TYPES.WRITE_OFF.sign).toBe('CREDIT')
  })

  it('gives whole-number units zero decimals so "1.5 pieces" is rejected at the source', () => {
    expect(UNIT_DEFINITIONS.PIECE.decimals).toBe(0)
    expect(UNIT_DEFINITIONS.PACKET.decimals).toBe(0)
    expect(UNIT_DEFINITIONS.DOZEN.decimals).toBe(0)
    // Loose goods carry the full 10^-3 scale, so 750 g can be sold as 0.750 kg.
    expect(UNIT_DEFINITIONS.KG.decimals).toBe(3)
    expect(UNIT_DEFINITIONS.LITRE.decimals).toBe(3)
  })

  it('gives every unit a name in both languages', () => {
    for (const [code, def] of Object.entries(UNIT_DEFINITIONS)) {
      expect(def.nameEn.length, `${code} missing English`).toBeGreaterThan(0)
      expect(def.nameHi.length, `${code} missing Hindi`).toBeGreaterThan(0)
      expect(def.nameHi, `${code} Hindi is not Devanagari`).toMatch(/[ऀ-ॿ]/)
    }
  })

  it('keeps the cashier-forbidden permissions in the vocabulary', () => {
    // The ROLE_CEILING in @dukaano/business-logic references these by name; a rename here
    // without one there would silently drop a ceiling entry and open an escalation path.
    const ceilingCritical: Permission[] = [
      'product.view.cost',
      'customer.ledger.adjust',
      'report.profit',
      'employee.manage',
      'subscription.manage',
    ]
    for (const permission of ceilingCritical) {
      expect(PERMISSIONS).toContain(permission)
    }
  })
})
