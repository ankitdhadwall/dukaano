import { describe, expect, it } from 'vitest'
import { createCategorySchema, createProductSchema, stockAdjustmentSchema } from './catalogue'
import { columnMappingSchema, importCommitSchema, importPreviewSchema } from './import'
import {
  cancelSaleSchema,
  createCustomerSchema,
  createReturnSchema,
  createSaleSchema,
  ledgerAdjustmentSchema,
  recordPaymentSchema,
} from './sale'
import { numberLeaseSchema, registerDeviceSchema, syncPullSchema, syncPushSchema } from './sync'
import { loginSchema, registerSchema } from './auth'
import {
  permissionOverridesSchema,
  shopProfileSchema,
  shopSettingsSchema,
  updateMembershipSchema,
} from './shop'

/**
 * The schemas are not paperwork — the refinements in them are business rules, and they are the
 * last line before a bad value reaches a service. These tests cover the rules, not Zod.
 *
 * Every message is an **i18n key**, never prose (§24.1), so the assertions check keys: a schema
 * that started returning English would make Hindi a second-class experience at exactly the moment
 * a shopkeeper most needs to understand what went wrong.
 */

const firstIssue = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues[0]?.message

describe('product', () => {
  const valid = { unitCode: 'KG' as const, sellingPricePaise: 4_450, nameEn: 'Sugar' }

  it('accepts a product named in either language', () => {
    expect(createProductSchema.safeParse(valid).success).toBe(true)
    expect(createProductSchema.safeParse({ ...valid, nameEn: undefined, nameHi: 'चीनी' }).success).toBe(true)
  })

  it('rejects a product with no name at all', () => {
    const result = createProductSchema.safeParse({ ...valid, nameEn: undefined })
    expect(result.success).toBe(false)
    expect(firstIssue(result)).toBe('errors.product.nameRequired')
  })

  it('rejects fractional opening stock on a whole-number unit (§25 E-22)', () => {
    // "1.5 pieces" is not a thing; truncating silently would lose the shopkeeper half a unit.
    const result = createProductSchema.safeParse({
      ...valid,
      unitCode: 'PIECE',
      openingStockMilli: 1_500,
    })
    expect(result.success).toBe(false)
    expect(firstIssue(result)).toBe('errors.quantity.tooManyDecimals')
  })

  it('allows fractional opening stock on a unit that permits it', () => {
    expect(
      createProductSchema.safeParse({ ...valid, unitCode: 'KG', openingStockMilli: 1_500 }).success,
    ).toBe(true)
  })

  it('rejects an unknown unit with a translatable key', () => {
    const result = createProductSchema.safeParse({ ...valid, unitCode: 'QUINTAL' })
    expect(firstIssue(result)).toBe('errors.product.invalidUnit')
  })

  it('rejects a negative price', () => {
    expect(createProductSchema.safeParse({ ...valid, sellingPricePaise: -1 }).success).toBe(false)
  })

  it('rejects a non-integer price — money is integer paise (§15.1)', () => {
    expect(createProductSchema.safeParse({ ...valid, sellingPricePaise: 44.5 }).success).toBe(false)
  })

  it('preserves the unit as a literal type rather than widening to string', () => {
    const parsed = createProductSchema.parse(valid)
    // The cast in catalogue.ts exists for this; widening would force a cast at every call site.
    expect(parsed.unitCode).toBe('KG')
  })
})

describe('category', () => {
  it('requires a name in at least one language', () => {
    expect(createCategorySchema.safeParse({}).success).toBe(false)
    expect(firstIssue(createCategorySchema.safeParse({}))).toBe('errors.category.nameRequired')
    expect(createCategorySchema.safeParse({ nameHi: 'मसाले' }).success).toBe(true)
  })
})

describe('stock adjustment', () => {
  const valid = {
    productId: '00000000-0000-4000-8000-000000000001',
    type: 'DAMAGE' as const,
    qtyDeltaMilli: -1_000,
    reason: 'Spoiled',
  }

  it('requires a reason — stock never changes without a trace (§17.1)', () => {
    expect(stockAdjustmentSchema.safeParse({ ...valid, reason: '' }).success).toBe(false)
  })

  it('refuses a zero movement, which records nothing and pollutes the history', () => {
    const result = stockAdjustmentSchema.safeParse({ ...valid, qtyDeltaMilli: 0 })
    expect(firstIssue(result)).toBe('errors.inventory.zeroMovement')
  })

  it('accepts a signed delta in either direction', () => {
    expect(stockAdjustmentSchema.safeParse({ ...valid, qtyDeltaMilli: 500 }).success).toBe(true)
  })
})

describe('sale', () => {
  const item = {
    productId: '00000000-0000-4000-8000-000000000001',
    qtyMilli: 1_000,
    unitPricePaise: 5_000,
  }

  it('accepts a fully-paid cash sale with no customer', () => {
    const result = createSaleSchema.safeParse({
      items: [item],
      payments: [{ method: 'CASH', amountPaise: 5_000 }],
    })
    expect(result.success).toBe(true)
  })

  it('requires a customer when the bill is not fully paid', () => {
    const result = createSaleSchema.safeParse({
      items: [item],
      payments: [{ method: 'CASH', amountPaise: 1_000 }],
    })
    expect(result.success).toBe(false)
    expect(firstIssue(result)).toBe('errors.sale.customerRequiredForCredit')
  })

  it('accepts an unpaid bill once a customer is named', () => {
    expect(
      createSaleSchema.safeParse({
        customerId: '00000000-0000-4000-8000-000000000002',
        items: [item],
        payments: [],
      }).success,
    ).toBe(true)
  })

  it('rejects an empty cart', () => {
    expect(firstIssue(createSaleSchema.safeParse({ items: [] }))).toBe('errors.sale.emptyCart')
  })

  it('rejects a zero or negative quantity', () => {
    expect(createSaleSchema.safeParse({ items: [{ ...item, qtyMilli: 0 }] }).success).toBe(false)
  })

  it('does not accept UDHAAR as a payment method (§19.1)', () => {
    /*
     * The assertion that protects the whole accounting model. Udhaar is a selection in the UI that
     * produces a ledger entry; if it ever became a payment method, every "today's takings" figure
     * would include money the shop never received.
     */
    const result = createSaleSchema.safeParse({
      customerId: '00000000-0000-4000-8000-000000000002',
      items: [item],
      payments: [{ method: 'UDHAAR', amountPaise: 5_000 }],
    })
    expect(result.success).toBe(false)
  })

  it('requires a reason to cancel', () => {
    expect(cancelSaleSchema.safeParse({}).success).toBe(false)
    expect(cancelSaleSchema.safeParse({ reason: 'Customer changed their mind' }).success).toBe(true)
  })

  it('requires at least one line on a return', () => {
    expect(firstIssue(createReturnSchema.safeParse({ items: [] }))).toBe('errors.sale.emptyReturn')
  })
})

describe('payments and khata', () => {
  const customerId = '00000000-0000-4000-8000-000000000002'

  it('requires a positive amount', () => {
    expect(
      recordPaymentSchema.safeParse({ customerId, method: 'CASH', amountPaise: 0 }).success,
    ).toBe(false)
  })

  it('accepts a manual allocation override', () => {
    const result = recordPaymentSchema.safeParse({
      customerId,
      method: 'CASH',
      amountPaise: 30_000,
      allocations: [{ saleId: '00000000-0000-4000-8000-000000000003', amountPaise: 30_000 }],
    })
    expect(result.success).toBe(true)
  })

  it('requires a reason on a manual khata correction', () => {
    const base = { customerId, entryType: 'WRITE_OFF' as const, magnitudePaise: 50_000 }
    expect(ledgerAdjustmentSchema.safeParse(base).success).toBe(false)
    expect(ledgerAdjustmentSchema.safeParse({ ...base, reason: 'Uncollectable' }).success).toBe(true)
  })

  it('only allows correction entry types, not arbitrary ledger writes', () => {
    // SALE_CREDIT and PAYMENT_RECEIVED are produced by the sale and payment paths; letting an
    // owner post one by hand would put an entry in the ledger with no document behind it.
    const result = ledgerAdjustmentSchema.safeParse({
      customerId,
      entryType: 'SALE_CREDIT',
      magnitudePaise: 1_000,
      reason: 'Nope',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a customer with only a name', () => {
    // A khata regular is often known by face; demanding a phone pushes the shopkeeper to paper.
    expect(createCustomerSchema.safeParse({ name: 'Ramesh' }).success).toBe(true)
  })

  it('rejects a nameless customer', () => {
    expect(firstIssue(createCustomerSchema.safeParse({ name: '' }))).toBe('errors.customer.nameRequired')
  })
})

describe('sync envelope', () => {
  const op = {
    opId: '00000000-0000-4000-8000-00000000000a',
    entity: 'sale',
    entityId: '00000000-0000-4000-8000-00000000000b',
    opType: 'create' as const,
    clientUpdatedAt: '2026-08-16T10:00:00.000Z',
    payload: {},
  }
  const deviceId = '00000000-0000-4000-8000-00000000000c'

  it('accepts a well-formed batch', () => {
    expect(syncPushSchema.safeParse({ deviceId, ops: [op] }).success).toBe(true)
  })

  it('rejects an empty batch', () => {
    expect(firstIssue(syncPushSchema.safeParse({ deviceId, ops: [] }))).toBe('errors.sync.emptyBatch')
  })

  it('rejects a repeated op id within one batch rather than deduplicating it', () => {
    /*
     * Deduplicating would be friendlier and wrong: two ops sharing an id means the client's outbox
     * is generating colliding keys, and the entire duplicate-sale defence rests on those being
     * unique. Silently accepting one hides a client bug whose next symptom is a vanished sale.
     */
    const result = syncPushSchema.safeParse({ deviceId, ops: [op, { ...op, entityId: deviceId }] })
    expect(firstIssue(result)).toBe('errors.sync.duplicateOpIdInBatch')
  })

  it('coerces the client timestamp from a JSON string', () => {
    const parsed = syncPushSchema.parse({ deviceId, ops: [op] })
    expect(parsed.ops[0]?.clientUpdatedAt).toBeInstanceOf(Date)
  })

  it('validates a pull cursor in both accepted forms', () => {
    expect(syncPullSchema.safeParse({ deviceId, cursor: '4210' }).success).toBe(true)
    expect(syncPullSchema.safeParse({ deviceId, cursor: '4210:99' }).success).toBe(true)
    expect(syncPullSchema.safeParse({ deviceId, cursor: 'nonsense' }).success).toBe(false)
  })

  it('defaults the pull limit rather than requiring the client to pick one', () => {
    expect(syncPullSchema.parse({ deviceId }).limit).toBe(200)
  })

  it('requires a platform when registering a device', () => {
    expect(registerDeviceSchema.safeParse({ platform: 'ANDROID' }).success).toBe(true)
    expect(registerDeviceSchema.safeParse({ platform: 'WINDOWS_PHONE' }).success).toBe(false)
  })

  it('caps a number lease so a lost device does not take a year of numbers with it', () => {
    expect(numberLeaseSchema.parse({ deviceId }).size).toBe(200)
    expect(numberLeaseSchema.safeParse({ deviceId, size: 5_000 }).success).toBe(false)
  })
})

describe('import', () => {
  const content = 'Name,Unit,Price\nSugar,KG,44.50\n'

  it('accepts a preview with no mapping, so the server can detect one', () => {
    expect(importPreviewSchema.safeParse({ content }).success).toBe(true)
  })

  it('rejects an empty file', () => {
    expect(firstIssue(importPreviewSchema.safeParse({ content: '' }))).toBe('errors.import.fileEmpty')
  })

  it('requires a mapping on commit — never re-detected server-side', () => {
    // Silently re-running detection at commit could map a column differently from what the
    // shopkeeper approved on screen.
    expect(importCommitSchema.safeParse({ content }).success).toBe(false)
    expect(importCommitSchema.safeParse({ content, mapping: { nameEn: 0 } }).success).toBe(true)
  })

  it('defaults to accepting warning rows', () => {
    const parsed = importCommitSchema.parse({ content, mapping: { nameEn: 0 } })
    expect(parsed.acceptWarnings).toBe(true)
  })

  it('rejects an unknown column in a mapping', () => {
    expect(columnMappingSchema.safeParse({ nameEn: 0, godownRack: 3 }).success).toBe(false)
  })

  it('keys duplicate decisions by line number', () => {
    const parsed = importCommitSchema.parse({
      content,
      mapping: { nameEn: 0 },
      decisions: { '2': 'UPDATE' },
    })
    expect(parsed.decisions).toEqual({ '2': 'UPDATE' })
  })
})

describe('auth', () => {
  it('normalizes and validates an Indian mobile on register', () => {
    const result = registerSchema.safeParse({
      phone: '9816012345',
      password: 'correct horse battery',
      fullName: 'Ankit',
      shopName: 'Dhadwal Store',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a landline, which can never receive a reminder', () => {
    expect(
      registerSchema.safeParse({
        phone: '01772345678',
        password: 'correct horse battery',
        fullName: 'Ankit',
        shopName: 'Dhadwal Store',
      }).success,
    ).toBe(false)
  })

  it('enforces the password policy on register but NOT on login', () => {
    /*
     * Deliberate asymmetry. Register applies the 8-character minimum; login accepts any non-empty
     * string and lets authentication fail.
     *
     * Rejecting a short password at login would leak the policy to anyone probing the endpoint and
     * hand them a free filter — and it would lock out any existing account whose password predates
     * a policy change, turning a rule tightening into an outage.
     */
    const register = (password: string) =>
      registerSchema.safeParse({ phone: '9816012345', password, fullName: 'Ankit', shopName: 'Store' })
    expect(register('short').success).toBe(false)
    expect(register('correct horse battery').success).toBe(true)

    expect(loginSchema.safeParse({ phone: '9816012345', password: 'abc' }).success).toBe(true)
    expect(loginSchema.safeParse({ phone: '9816012345', password: '' }).success).toBe(false)
  })

  it('requires a phone or an email to identify the account', () => {
    expect(loginSchema.safeParse({ password: 'whatever' }).success).toBe(false)
  })
})

describe('shop settings and memberships', () => {
  it('accepts a business day that starts after midnight (§25 E-20)', () => {
    // A shop open past midnight sets 4, so a 00:30 sale counts as the previous day's takings.
    expect(shopSettingsSchema.safeParse({ businessDayStartHour: 4 }).success).toBe(true)
    expect(shopSettingsSchema.safeParse({ businessDayStartHour: 24 }).success).toBe(false)
    expect(shopSettingsSchema.safeParse({ businessDayStartHour: -1 }).success).toBe(false)
  })

  it('accepts the documented stock and rounding policies only', () => {
    expect(shopSettingsSchema.safeParse({ negativeStockPolicy: 'ALLOW' }).success).toBe(true)
    expect(shopSettingsSchema.safeParse({ negativeStockPolicy: 'PRETEND' }).success).toBe(false)
    expect(shopSettingsSchema.safeParse({ roundingPolicy: 'NEAREST_RUPEE' }).success).toBe(true)
  })

  it('caps a cashier discount in basis points', () => {
    expect(shopSettingsSchema.safeParse({ maxCashierDiscountBp: 10_000 }).success).toBe(true)
    expect(shopSettingsSchema.safeParse({ maxCashierDiscountBp: 10_001 }).success).toBe(false)
  })

  it('validates the shape of permission overrides but not the authority to hold them', () => {
    /*
     * Deliberate. The ROLE_CEILING check lives server-side in @dukaano/business-logic and is
     * applied last (§9.2). If the schema enforced it, a client that skipped validation could
     * escalate — so the schema checks shape and the server checks authority.
     */
    const overreach = { grant: ['customer.ledger.adjust'] }
    expect(permissionOverridesSchema.safeParse(overreach).success).toBe(true)
    expect(permissionOverridesSchema.safeParse({ grant: ['not.a.permission'] }).success).toBe(false)
  })

  it('accepts a membership update with a known role and status', () => {
    expect(updateMembershipSchema.safeParse({ role: 'CASHIER', status: 'SUSPENDED' }).success).toBe(true)
    expect(updateMembershipSchema.safeParse({ role: 'SUPERUSER' }).success).toBe(false)
  })

  it('accepts a shop profile with a valid timezone and locale', () => {
    const result = shopProfileSchema.safeParse({ name: 'Dhadwal Store', defaultLocale: 'hi' })
    expect(result.success).toBe(true)
  })
})

/**
 * The remaining `errorMap` callbacks.
 *
 * Each one only executes when its specific validation fails, and each exists so the client gets a
 * translatable key instead of Zod's English default — which would put raw English in front of a
 * Hindi-first shopkeeper at exactly the wrong moment. Worth asserting rather than assuming.
 */
describe('every custom error map returns a translatable key', () => {
  const cases: [string, { success: boolean; error?: { issues: { message: string }[] } }, string][] = [
    [
      'invalid locale on register',
      registerSchema.safeParse({
        phone: '9816012345',
        password: 'correct horse battery',
        fullName: 'Ankit',
        shopName: 'Store',
        locale: 'fr',
      }),
      'errors.locale.invalid',
    ],
    [
      'invalid inventory adjustment type',
      stockAdjustmentSchema.safeParse({
        productId: '00000000-0000-4000-8000-000000000001',
        type: 'VANISHED',
        qtyDeltaMilli: -1,
        reason: 'x',
      }),
      'errors.inventory.invalidType',
    ],
    [
      'invalid payment method',
      recordPaymentSchema.safeParse({
        customerId: '00000000-0000-4000-8000-000000000002',
        method: 'BARTER',
        amountPaise: 100,
      }),
      'errors.payment.invalidMethod',
    ],
    [
      'invalid adjustment type',
      ledgerAdjustmentSchema.safeParse({
        customerId: '00000000-0000-4000-8000-000000000002',
        entryType: 'MADE_UP',
        magnitudePaise: 100,
        reason: 'x',
      }),
      'errors.khata.invalidAdjustment',
    ],
    [
      'invalid sync op type',
      syncPushSchema.safeParse({
        deviceId: '00000000-0000-4000-8000-00000000000c',
        ops: [
          {
            opId: '00000000-0000-4000-8000-00000000000a',
            entity: 'sale',
            entityId: '00000000-0000-4000-8000-00000000000b',
            opType: 'demolish',
            clientUpdatedAt: '2026-08-16T10:00:00.000Z',
            payload: {},
          },
        ],
      }),
      'errors.sync.invalidOpType',
    ],
    [
      'invalid device platform',
      registerDeviceSchema.safeParse({ platform: 'SYMBIAN' }),
      'errors.sync.invalidPlatform',
    ],
  ]

  it.each(cases)('%s', (_name, result, expectedKey) => {
    expect(result.success).toBe(false)
    expect(result.error?.issues.some((issue) => issue.message === expectedKey)).toBe(true)
  })
})
