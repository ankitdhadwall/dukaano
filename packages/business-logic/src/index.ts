/**
 * @dukaano/business-logic — the pure domain rules.
 *
 * No I/O, no framework imports, no database types (blueprint §29). Everything here runs
 * identically on the NestJS server and inside the React Native client, which is what lets an
 * offline device compute the same permissions, the same business date and the same ledger
 * balance the server would.
 */

export {
  ROLE_DEFAULTS,
  ROLE_CEILING,
  ALL_ROLES,
  resolveEffectivePermissions,
  hasPermission,
  isGrantable,
  permissionFingerprint,
} from './rbac/matrix'

export {
  MAX_TRUSTED_CLOCK_SKEW_MS,
  computeBusinessDate,
  resolveBusinessTimestamp,
  todayFor,
  addDays,
  parseBusinessDate,
  type BusinessDate,
  type BusinessDateRange,
  type ResolvedTimestamp,
} from './time/business-date'
