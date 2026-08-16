import { z } from 'zod'
import { INVENTORY_TRANSACTION_TYPE_LIST, UNIT_CODES, UNIT_DEFINITIONS } from '@dukaano/types'
import type { UnitCode } from '@dukaano/types'

/**
 * Catalogue and inventory schemas.
 *
 * Money and quantity arrive as **integers** at their storage scale — paise and milli-units —
 * never as decimal strings or floats (blueprint §15.1). Parsing "44.50" into 4450 happens in the
 * client, using parseMoneyInput() from @dukaano/money, so that exactly one implementation of
 * that conversion exists and the wire format cannot carry a float.
 */

const paise = (field: string) =>
  z
    .number({ required_error: `errors.${field}.required`, invalid_type_error: `errors.${field}.invalid` })
    .int(`errors.${field}.invalid`)
    .min(0, `errors.${field}.negative`)
    .max(Number.MAX_SAFE_INTEGER)

const milli = z.number().int('errors.quantity.invalid').max(Number.MAX_SAFE_INTEGER)

// Cast to a literal tuple rather than `[string, ...string[]]`: the wider form widens the
// inferred output to `string`, which then fails to satisfy `UnitCode` at every call site and
// would tempt a cast in the controller instead — pushing the looseness one layer further in.
export const unitCodeSchema = z.enum(UNIT_CODES as unknown as [UnitCode, ...UnitCode[]], {
  errorMap: () => ({ message: 'errors.product.invalidUnit' }),
})

export const createProductSchema = z
  .object({
    nameEn: z.string().trim().max(120, 'errors.product.nameTooLong').optional(),
    nameHi: z.string().trim().max(120, 'errors.product.nameTooLong').optional(),
    sku: z.string().trim().max(40).optional(),
    shortCode: z.string().trim().max(20).optional(),
    categoryId: z.string().uuid().optional(),
    unitCode: unitCodeSchema,
    sellingPricePaise: paise('price'),
    purchasePricePaise: paise('price').optional(),
    mrpPaise: paise('price').optional(),
    lowStockThresholdMilli: milli.min(0).optional(),
    openingStockMilli: milli.min(0).optional(),
    aliases: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  // At least one language, matching the CHECK constraint. We never auto-translate the other
  // (§22.4) — a machine-translated "Kurkure Masala Munch" is nonsense and destroys trust.
  .refine((v) => Boolean(v.nameEn?.trim()) || Boolean(v.nameHi?.trim()), {
    message: 'errors.product.nameRequired',
    path: ['nameEn'],
  })
  // A whole-number unit must not carry fractional opening stock (§25 E-22).
  .refine(
    (v) => {
      const decimals = UNIT_DEFINITIONS[v.unitCode]?.decimals ?? 3
      return decimals > 0 || !v.openingStockMilli || v.openingStockMilli % 1000 === 0
    },
    { message: 'errors.quantity.tooManyDecimals', path: ['openingStockMilli'] },
  )
export type CreateProductInput = z.infer<typeof createProductSchema>

export const updateProductSchema = z.object({
  nameEn: z.string().trim().max(120).optional(),
  nameHi: z.string().trim().max(120).optional(),
  sku: z.string().trim().max(40).optional(),
  shortCode: z.string().trim().max(20).optional(),
  categoryId: z.string().uuid().optional(),
  unitCode: unitCodeSchema.optional(),
  sellingPricePaise: paise('price').optional(),
  purchasePricePaise: paise('price').optional(),
  mrpPaise: paise('price').optional(),
  lowStockThresholdMilli: milli.min(0).optional(),
})
export type UpdateProductInput = z.infer<typeof updateProductSchema>

/**
 * Manual stock adjustment.
 *
 * `qtyDeltaMilli` is SIGNED and may not be zero: a zero movement records nothing and pollutes
 * the history. A reason is required for every type this endpoint accepts, mirroring both the
 * CHECK constraint and §17.1 — "who reduced my sugar by 2 kg and why" must always be answerable.
 */
export const stockAdjustmentSchema = z.object({
  productId: z.string().uuid('errors.product.invalidId'),
  type: z.enum(['DAMAGE', 'WASTAGE', 'ADJUSTMENT', 'CORRECTION'], {
    errorMap: () => ({ message: 'errors.inventory.invalidType' }),
  }),
  qtyDeltaMilli: milli.refine((v) => v !== 0, { message: 'errors.inventory.zeroMovement' }),
  reason: z.string().trim().min(1, 'errors.inventory.reasonRequired').max(120),
  note: z.string().trim().max(500).optional(),
  unitCostPaise: paise('price').optional(),
})
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>

export const inventoryTransactionTypeSchema = z.enum(
  INVENTORY_TRANSACTION_TYPE_LIST as unknown as [string, ...string[]],
)

/**
 * Categories.
 *
 * Same bilingual rule as products: at least one language, and we never auto-translate the other.
 * A category is organisational only — nothing financial depends on it — which is why it may be
 * renamed freely and why archiving one does not touch the products inside it.
 */
export const createCategorySchema = z
  .object({
    nameEn: z.string().trim().max(80, 'errors.category.nameTooLong').optional(),
    nameHi: z.string().trim().max(80, 'errors.category.nameTooLong').optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .refine((v) => Boolean(v.nameEn?.trim()) || Boolean(v.nameHi?.trim()), {
    message: 'errors.category.nameRequired',
    path: ['nameEn'],
  })
export type CreateCategoryInput = z.infer<typeof createCategorySchema>

export const updateCategorySchema = z.object({
  nameEn: z.string().trim().max(80, 'errors.category.nameTooLong').optional(),
  nameHi: z.string().trim().max(80, 'errors.category.nameTooLong').optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
})
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>

/**
 * Adopting products from the platform master catalogue (blueprint §7, risk R-1).
 *
 * Prices are supplied per item by the shopkeeper, never copied from the master row. The master
 * `hintPricePaise` is a starting suggestion the UI may pre-fill, but it must cross the wire as an
 * explicit choice — a shop in Shimla and a shop in Solan do not charge the same for atta, and
 * silently adopting a platform price would put a number on their shelf that they never agreed to.
 */
export const adoptMasterProductsSchema = z.object({
  items: z
    .array(
      z.object({
        masterProductId: z.string().uuid('errors.product.invalidId'),
        sellingPricePaise: paise('price'),
        purchasePricePaise: paise('price').optional(),
        mrpPaise: paise('price').optional(),
        openingStockMilli: milli.min(0).optional(),
        lowStockThresholdMilli: milli.min(0).optional(),
      }),
    )
    .min(1, 'errors.import.noRows')
    .max(200, 'errors.import.tooManyRows'),
})
export type AdoptMasterProductsInput = z.infer<typeof adoptMasterProductsSchema>
