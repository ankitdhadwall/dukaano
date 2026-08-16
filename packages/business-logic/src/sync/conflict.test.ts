import { describe, expect, it } from 'vitest'
import {
  APPEND_ONLY_ENTITIES,
  PRICE_FIELDS,
  SERVER_AUTHORITATIVE_FIELDS,
  authorizeQueuedOperation,
  isAppendOnlyFact,
  resolveProductConflict,
} from './conflict'

const SERVER_TIME = new Date('2026-08-16T10:00:00.000Z')
const NEWER = new Date('2026-08-16T10:00:01.000Z')
const OLDER = new Date('2026-08-16T09:59:59.000Z')

const server = (overrides: Partial<{ rowVersion: number; effectiveUpdatedAt: Date }> = {}) => ({
  rowVersion: 7,
  effectiveUpdatedAt: SERVER_TIME,
  ...overrides,
})

describe('resolveProductConflict — non-price fields (plain last-write-wins)', () => {
  it('accepts a newer client edit', () => {
    const result = resolveProductConflict(
      { patch: { nameEn: 'Sugar Loose' }, clientUpdatedAt: NEWER, baseVersion: 7 },
      server(),
    )

    expect(result.accepted).toEqual({ nameEn: 'Sugar Loose' })
    expect(result.hasConflict).toBe(false)
  })

  it('refuses a stale client edit and says why', () => {
    const result = resolveProductConflict(
      { patch: { nameEn: 'Old Name' }, clientUpdatedAt: OLDER, baseVersion: 7 },
      server(),
    )

    expect(result.accepted).toEqual({})
    expect(result.rejected).toEqual([{ field: 'nameEn', reason: 'STALE' }])
    expect(result.hasConflict).toBe(true)
  })

  it('gives an exact tie to the server', () => {
    // Two writes on the same millisecond are far more likely to be one clock being wrong than a
    // genuine race, and the server's copy is the one everyone else has already seen.
    const result = resolveProductConflict(
      { patch: { nameEn: 'Tied' }, clientUpdatedAt: SERVER_TIME, baseVersion: 7 },
      server(),
    )

    expect(result.rejected).toEqual([{ field: 'nameEn', reason: 'STALE' }])
  })

  it('accepts a newer non-price edit even when made against an older row version', () => {
    // Only prices carry the version requirement. Requiring it everywhere would send every
    // slightly-behind rename to the conflict inbox for no benefit.
    const result = resolveProductConflict(
      { patch: { nameHi: 'चीनी' }, clientUpdatedAt: NEWER, baseVersion: 3 },
      server(),
    )

    expect(result.accepted).toEqual({ nameHi: 'चीनी' })
  })

  it('accepts an explicit null as a clearing edit', () => {
    // `null` means "remove the SKU"; only `undefined` means "not part of this patch".
    const result = resolveProductConflict(
      { patch: { sku: null }, clientUpdatedAt: NEWER, baseVersion: 7 },
      server(),
    )

    expect(result.accepted).toEqual({ sku: null })
  })

  it('ignores undefined fields entirely', () => {
    const result = resolveProductConflict(
      { patch: { nameEn: 'Kept', nameHi: undefined }, clientUpdatedAt: NEWER, baseVersion: 7 },
      server(),
    )

    expect(result.accepted).toEqual({ nameEn: 'Kept' })
    expect(result.rejected).toEqual([])
  })
})

describe('resolveProductConflict — prices (the stricter rule)', () => {
  it.each(PRICE_FIELDS)('accepts %s when newer AND against the current version', (field) => {
    const result = resolveProductConflict(
      { patch: { [field]: 4600 }, clientUpdatedAt: NEWER, baseVersion: 7 },
      server(),
    )

    expect(result.accepted).toEqual({ [field]: 4600 })
    expect(result.hasConflict).toBe(false)
  })

  it.each(PRICE_FIELDS)('refuses %s when the edit was made against an older version', (field) => {
    // The phone in a drawer: its price predates a supplier increase it never saw. Applying it
    // would have the shop selling at a loss with nothing to point at.
    const result = resolveProductConflict(
      { patch: { [field]: 4000 }, clientUpdatedAt: NEWER, baseVersion: 3 },
      server(),
    )

    expect(result.accepted).toEqual({})
    expect(result.rejected).toEqual([{ field, reason: 'PRICE_NEEDS_CURRENT_VERSION' }])
  })

  it('refuses a price edit from a client that never saw the row', () => {
    const result = resolveProductConflict(
      { patch: { sellingPricePaise: 100 }, clientUpdatedAt: NEWER },
      server(),
    )

    expect(result.rejected[0]?.reason).toBe('PRICE_NEEDS_CURRENT_VERSION')
  })

  it('reports STALE rather than the version reason when the edit is also old', () => {
    // Staleness is the more useful thing to tell the shopkeeper: their phone is behind, which is
    // one explanation covering every refused field rather than two competing ones.
    const result = resolveProductConflict(
      { patch: { sellingPricePaise: 100 }, clientUpdatedAt: OLDER, baseVersion: 3 },
      server(),
    )

    expect(result.rejected).toEqual([{ field: 'sellingPricePaise', reason: 'STALE' }])
  })

  it('does NOT apply the price rule to MRP', () => {
    // MRP is printed on the packet — a fact being copied, not a decision being made. Guarding it
    // would produce inbox noise with no financial benefit.
    const result = resolveProductConflict(
      { patch: { mrpPaise: 5000 }, clientUpdatedAt: NEWER, baseVersion: 3 },
      server(),
    )

    expect(result.accepted).toEqual({ mrpPaise: 5000 })
  })

  it('keeps the safe half of a patch that also carries a stale price', () => {
    // The case that justifies resolving per field: all-or-nothing would either lose the rename
    // or apply the bad price.
    const result = resolveProductConflict(
      {
        patch: { nameEn: 'Sugar Loose 1kg', sellingPricePaise: 4000 },
        clientUpdatedAt: NEWER,
        baseVersion: 3,
      },
      server(),
    )

    expect(result.accepted).toEqual({ nameEn: 'Sugar Loose 1kg' })
    expect(result.rejected).toEqual([
      { field: 'sellingPricePaise', reason: 'PRICE_NEEDS_CURRENT_VERSION' },
    ])
    expect(result.hasConflict).toBe(true)
  })
})

describe('resolveProductConflict — fields the server owns', () => {
  it.each(SERVER_AUTHORITATIVE_FIELDS)('always refuses %s, however new the edit', (field) => {
    const result = resolveProductConflict(
      { patch: { [field]: 'anything' }, clientUpdatedAt: NEWER, baseVersion: 7 },
      server(),
    )

    expect(result.accepted).toEqual({})
    expect(result.rejected).toEqual([{ field, reason: 'SERVER_AUTHORITATIVE' }])
  })

  it('refuses archive status even alongside acceptable fields', () => {
    const result = resolveProductConflict(
      { patch: { nameEn: 'Fine', archivedAt: new Date() }, clientUpdatedAt: NEWER, baseVersion: 7 },
      server(),
    )

    expect(result.accepted).toEqual({ nameEn: 'Fine' })
    expect(result.rejected).toEqual([{ field: 'archivedAt', reason: 'SERVER_AUTHORITATIVE' }])
  })
})

describe('resolveProductConflict — the empty patch', () => {
  it('is not a conflict', () => {
    const result = resolveProductConflict({ patch: {}, clientUpdatedAt: NEWER }, server())
    expect(result).toEqual({ accepted: {}, rejected: [], hasConflict: false })
  })
})

describe('isAppendOnlyFact', () => {
  it.each(APPEND_ONLY_ENTITIES)('treats a %s create as a fact', (entity) => {
    expect(isAppendOnlyFact(entity, 'create')).toBe(true)
  })

  it('is case-insensitive on the op type', () => {
    expect(isAppendOnlyFact('sale', 'CREATE')).toBe(true)
  })

  it('does not treat an update or archive of a fact as a fact', () => {
    // Cancelling a sale changes the interpretation of what happened; it is not itself a new fact.
    expect(isAppendOnlyFact('sale', 'update')).toBe(false)
    expect(isAppendOnlyFact('sale', 'archive')).toBe(false)
  })

  it('does not treat mutable entities as facts', () => {
    expect(isAppendOnlyFact('product', 'create')).toBe(false)
    expect(isAppendOnlyFact('customer', 'create')).toBe(false)
  })
})

describe('authorizeQueuedOperation — the E-31 asymmetry', () => {
  it('allows anything from a user who still holds the permission', () => {
    expect(
      authorizeQueuedOperation({ entity: 'product', opType: 'update', holdsPermissionNow: true }),
    ).toEqual({ allowed: true })
  })

  it('accepts a sale created offline by a since-demoted cashier', () => {
    // The goods left the shop and the money entered the till. Refusing the record does not undo
    // either — it only means the books stop describing reality and the drawer will not balance.
    expect(
      authorizeQueuedOperation({ entity: 'sale', opType: 'create', holdsPermissionNow: false }),
    ).toEqual({ allowed: true })
  })

  it('accepts an offline payment from a since-demoted cashier', () => {
    expect(
      authorizeQueuedOperation({ entity: 'payment', opType: 'create', holdsPermissionNow: false }),
    ).toEqual({ allowed: true })
  })

  it('refuses a cancellation from a since-demoted cashier', () => {
    // A dismissed cashier must not be able to cancel yesterday's sales from a phone they kept.
    expect(
      authorizeQueuedOperation({ entity: 'sale', opType: 'update', holdsPermissionNow: false }),
    ).toEqual({ allowed: false, reason: 'PERMISSION_REVOKED' })
  })

  it('refuses a product edit from a since-demoted user', () => {
    expect(
      authorizeQueuedOperation({ entity: 'product', opType: 'update', holdsPermissionNow: false }),
    ).toEqual({ allowed: false, reason: 'PERMISSION_REVOKED' })
  })

  it('refuses an inventory adjustment from a since-demoted user', () => {
    // An adjustment is a judgement about stock, not a record of a transaction that happened.
    expect(
      authorizeQueuedOperation({
        entity: 'inventory_transaction',
        opType: 'update',
        holdsPermissionNow: false,
      }),
    ).toEqual({ allowed: false, reason: 'PERMISSION_REVOKED' })
  })
})
