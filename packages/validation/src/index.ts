/**
 * @dukaano/validation — one definition of "valid" for the API, the web forms and the mobile app.
 *
 * All messages are i18n keys, never prose (blueprint §24.1): the server returns the key and the
 * client renders it in the reader's language.
 */

export {
  normalizeIndianPhone,
  toE164,
  isValidIndianPhone,
  lastFour,
  looksLikePhoneFragment,
  INDIA_COUNTRY_CODE,
  INDIA_DIAL_PREFIX,
  type PhoneParseResult,
} from './phone'

export {
  indianPhoneSchema,
  passwordSchema,
  localeSchema,
  registerSchema,
  loginSchema,
  refreshSchema,
  inviteMemberSchema,
  type RegisterInput,
  type LoginInput,
  type RefreshInput,
  type InviteMemberInput,
} from './schemas/auth'

export {
  shopProfileSchema,
  shopSettingsSchema,
  permissionOverridesSchema,
  updateMembershipSchema,
  type ShopProfileInput,
  type ShopSettingsInput,
  type PermissionOverridesInput,
  type UpdateMembershipInput,
} from './schemas/shop'
