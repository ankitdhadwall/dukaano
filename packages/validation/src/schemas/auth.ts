import { z } from 'zod'
import { LOCALES, SHOP_ROLES } from '@dukaano/types'
import { normalizeIndianPhone } from '../phone'

/**
 * Auth and onboarding schemas.
 *
 * One definition of "valid" shared by the API's DTO validation, the web forms and the mobile
 * forms (blueprint §11). A rule tightened here tightens everywhere, so the three surfaces cannot
 * drift into accepting different data.
 *
 * Every message is an **i18n key**, never prose: the server returns the key and the client
 * renders it in the reader's language (§24.1). A server that returns English text makes Hindi a
 * second-class experience the moment anything goes wrong.
 */

/** Accepts any form a shopkeeper types and emits canonical E.164. */
export const indianPhoneSchema = z
  .string({ required_error: 'errors.phone.required' })
  .transform((raw, ctx) => {
    const result = normalizeIndianPhone(raw)
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.errorKey })
      return z.NEVER
    }
    return result.e164
  })

/**
 * Password policy.
 *
 * Deliberately a length floor with no composition rules. NIST guidance has moved away from
 * forced symbol/digit mixes, and for this audience specifically — shopkeepers typing on a phone
 * keyboard, often assisted by a family member — a "must contain a special character" rule
 * produces `Password1!` and a note stuck to the counter. Eight characters, checked against
 * nothing else, is both more usable and no weaker in practice.
 */
export const passwordSchema = z
  .string({ required_error: 'errors.password.required' })
  .min(8, 'errors.password.tooShort')
  .max(128, 'errors.password.tooLong')

export const localeSchema = z.enum(LOCALES, { errorMap: () => ({ message: 'errors.locale.invalid' }) })

export const registerSchema = z.object({
  phone: indianPhoneSchema,
  password: passwordSchema,
  fullName: z
    .string({ required_error: 'errors.name.required' })
    .trim()
    .min(2, 'errors.name.tooShort')
    .max(120, 'errors.name.tooLong'),
  shopName: z
    .string({ required_error: 'errors.shop.nameRequired' })
    .trim()
    .min(2, 'errors.shop.nameTooShort')
    .max(160, 'errors.shop.nameTooLong'),
  locale: localeSchema.optional(),
  /// IANA zone. Defaults to Asia/Kolkata server-side rather than being required of the user.
  timezone: z.string().max(64).optional(),
  stateCode: z.string().length(2).optional(),
  city: z.string().trim().max(80).optional(),
})
export type RegisterInput = z.infer<typeof registerSchema>

export const loginSchema = z.object({
  /// Phone OR email. Phone is the Indian default; email exists for the web admin.
  phone: indianPhoneSchema.optional(),
  email: z.string().email('errors.email.invalid').optional(),
  password: z.string({ required_error: 'errors.password.required' }).min(1, 'errors.password.required'),
  deviceId: z.string().uuid('errors.device.invalid').optional(),
  deviceName: z.string().max(80).optional(),
  platform: z.enum(['ANDROID', 'IOS', 'WEB']).optional(),
  appVersion: z.string().max(32).optional(),
}).refine((v) => Boolean(v.phone) || Boolean(v.email), {
  message: 'errors.auth.identifierRequired',
  path: ['phone'],
})
export type LoginInput = z.infer<typeof loginSchema>

export const refreshSchema = z.object({
  refreshToken: z.string({ required_error: 'errors.auth.refreshRequired' }).min(1),
})
export type RefreshInput = z.infer<typeof refreshSchema>

export const inviteMemberSchema = z.object({
  phone: indianPhoneSchema,
  fullName: z.string().trim().min(2, 'errors.name.tooShort').max(120),
  role: z.enum(SHOP_ROLES, { errorMap: () => ({ message: 'errors.role.invalid' }) }),
  /// A temporary password the owner reads out. OTP invites arrive in Phase 2 (§23.1).
  temporaryPassword: passwordSchema,
})
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>
