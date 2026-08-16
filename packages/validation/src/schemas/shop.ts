import { z } from 'zod'
import { LOCALES, NEGATIVE_STOCK_POLICIES, PERMISSIONS, SHOP_ROLES } from '@dukaano/types'
import { ROUNDING_POLICIES } from '@dukaano/money'

/** Shop profile and settings schemas (blueprint §7 Settings, §17.3, §25 E-20). */

export const shopProfileSchema = z.object({
  name: z.string().trim().min(2, 'errors.shop.nameTooShort').max(160),
  shopType: z.string().max(40).optional(),
  phone: z.string().max(20).optional(),
  addressLine: z.string().max(240).optional(),
  city: z.string().max(80).optional(),
  stateCode: z.string().length(2).optional(),
  pincode: z.string().regex(/^\d{6}$/, 'errors.pincode.invalid').optional(),
  timezone: z.string().max(64).optional(),
  defaultLocale: z.enum(LOCALES).optional(),
})
export type ShopProfileInput = z.infer<typeof shopProfileSchema>

export const shopSettingsSchema = z.object({
  negativeStockPolicy: z.enum(NEGATIVE_STOCK_POLICIES).optional(),
  roundingPolicy: z
    .enum(Object.keys(ROUNDING_POLICIES) as [string, ...string[]])
    .optional(),
  // 0-23. A shop open past midnight sets 4 so a 00:30 sale counts as the previous day (E-20).
  businessDayStartHour: z.number().int().min(0).max(23).optional(),
  messagingChannel: z.enum(['WA_DEEPLINK', 'WA_CLOUD', 'SMS']).optional(),
  receiptFooter: z.string().max(240).optional(),
  sendReceiptByDefault: z.boolean().optional(),
  // Caps how often one customer can be reminded. Protects the shop's relationship with them.
  reminderCooldownDays: z.number().int().min(0).max(90).optional(),
  defaultLowStockThresholdMilli: z.number().int().min(0).optional(),
  maxCashierDiscountBp: z.number().int().min(0).max(10000).optional(),
})
export type ShopSettingsInput = z.infer<typeof shopSettingsSchema>

/**
 * Per-membership permission overrides.
 *
 * Note what is NOT validated here: whether the role may actually hold these permissions. That is
 * the ROLE_CEILING check, and it lives server-side in @dukaano/business-logic where it is applied
 * last (§9.2). Enforcing it only in a schema would mean a client that skipped validation could
 * escalate — so the schema checks shape, and the server checks authority.
 */
export const permissionOverridesSchema = z.object({
  grant: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(),
  revoke: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(),
})
export type PermissionOverridesInput = z.infer<typeof permissionOverridesSchema>

export const updateMembershipSchema = z.object({
  role: z.enum(SHOP_ROLES).optional(),
  permissionOverrides: permissionOverridesSchema.optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REMOVED']).optional(),
})
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>
