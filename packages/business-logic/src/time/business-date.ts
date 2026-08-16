/**
 * Business-date resolution (blueprint §25 E-19, E-20, E-26).
 *
 * Three separate problems live here, and conflating them is how reports end up disagreeing with
 * what the shopkeeper remembers selling:
 *
 *   1. **Timezone.** Every timestamp is stored as UTC `timestamptz`. "Today's sales" means today
 *      in the *shop's* timezone, so the business date is computed at write time and **stored**
 *      on the row. Reports read the stored column; they never re-derive it. Re-deriving would
 *      mean a shop that moves timezone retroactively rewrites its own history.
 *
 *   2. **Business day boundary.** A shop open until 1 a.m. thinks of a 00:30 sale as belonging
 *      to the previous day. `businessDayStartHour` (default 0) shifts the boundary.
 *
 *   3. **Device clock skew.** An offline Android device with a wrong clock will backdate or
 *      future-date sales. We keep both the client and server timestamps and pick deliberately.
 */

/** A calendar date with no time and no zone. Always `YYYY-MM-DD`. */
export type BusinessDate = string & { readonly __businessDate: unique symbol }

/** Beyond this, a device clock is not merely imprecise — it is wrong, and we stop trusting it. */
export const MAX_TRUSTED_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
}

/**
 * Decompose an instant into wall-clock parts in a given IANA timezone.
 *
 * Uses Intl rather than a date library so this package stays dependency-free and the React
 * Native client runs identical code. `en-CA` is chosen because its short date format is
 * ISO-ordered, making the parts unambiguous to extract.
 */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })

  const parts = formatter.formatToParts(instant)
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type)
    if (!part) throw new RangeError(`Could not read "${type}" for timezone "${timeZone}"`)
    return Number(part.value)
  }

  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Format calendar parts as `YYYY-MM-DD`, shifting back by `dayOffset` days if needed. */
function toIsoDate(year: number, month: number, day: number, dayOffset = 0): BusinessDate {
  // Date.UTC handles month/year rollover; using UTC keeps this free of local-zone influence.
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}` as BusinessDate
}

/**
 * The business date an instant belongs to.
 *
 *   computeBusinessDate(new Date('2026-08-16T19:30:00Z'), 'Asia/Kolkata')     → '2026-08-17'
 *   computeBusinessDate(new Date('2026-08-16T19:30:00Z'), 'Asia/Kolkata', 4)  → '2026-08-16'
 *
 * The second case is the late-night shop: 01:00 IST on the 17th with a 4 a.m. boundary still
 * counts as the 16th's takings.
 *
 * @param occurredAt          The instant, in UTC.
 * @param timeZone            IANA zone from `shop.timezone`, e.g. 'Asia/Kolkata'.
 * @param businessDayStartHour Hour (0–23) at which the shop's day rolls over. Default 0.
 */
export function computeBusinessDate(
  occurredAt: Date,
  timeZone: string,
  businessDayStartHour = 0,
): BusinessDate {
  if (!Number.isInteger(businessDayStartHour) || businessDayStartHour < 0 || businessDayStartHour > 23) {
    throw new RangeError(`businessDayStartHour must be an integer 0–23, received ${businessDayStartHour}`)
  }
  if (Number.isNaN(occurredAt.getTime())) {
    throw new RangeError('computeBusinessDate received an invalid Date')
  }

  const { year, month, day, hour } = zonedParts(occurredAt, timeZone)
  return toIsoDate(year, month, day, hour < businessDayStartHour ? -1 : 0)
}

export interface ResolvedTimestamp {
  /** The instant to record as `occurred_at` and to derive the business date from. */
  readonly occurredAt: Date
  /** Signed skew: positive means the device clock is ahead of the server. */
  readonly skewMs: number
  /** True when the device clock was too far off to trust for business dating. */
  readonly clockSkewExceeded: boolean
}

/**
 * Choose which timestamp a synced offline mutation is dated by (blueprint §25 E-26).
 *
 * A device that has been offline for hours legitimately reports a `clientCreatedAt` well in the
 * past — that is the whole point, and we honour it, because the sale really did happen then.
 * But a device whose clock is simply *wrong* (a factory-reset phone reporting 1970, or one set
 * a year ahead) would otherwise file real sales into a business date that no report will ever
 * show, making money appear to vanish.
 *
 * The rule: trust the client's timestamp until the skew exceeds a day, then fall back to server
 * time and flag the device so the shopkeeper is prompted to fix their clock. Both timestamps are
 * persisted either way — we never discard what the device claimed.
 */
export function resolveBusinessTimestamp(
  clientCreatedAt: Date,
  serverReceivedAt: Date,
  maxSkewMs: number = MAX_TRUSTED_CLOCK_SKEW_MS,
): ResolvedTimestamp {
  const skewMs = clientCreatedAt.getTime() - serverReceivedAt.getTime()
  const clockSkewExceeded = Math.abs(skewMs) > maxSkewMs

  return {
    occurredAt: clockSkewExceeded ? serverReceivedAt : clientCreatedAt,
    skewMs,
    clockSkewExceeded,
  }
}

/** Inclusive `[from, to]` business-date range, for report queries. */
export interface BusinessDateRange {
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** Today's business date for a shop. */
export function todayFor(
  timeZone: string,
  businessDayStartHour = 0,
  now: Date = new Date(),
): BusinessDate {
  return computeBusinessDate(now, timeZone, businessDayStartHour)
}

/** Shift a business date by whole days. `addDays('2026-08-16', -1)` → `'2026-08-15'`. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  const [y, m, d] = date.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) {
    throw new RangeError(`Malformed business date: ${date}`)
  }
  return toIsoDate(y, m, d, days)
}

/** Parse and validate an untrusted `YYYY-MM-DD` string, e.g. a report filter from a query param. */
export function parseBusinessDate(value: unknown): BusinessDate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`Expected a YYYY-MM-DD business date, received: ${JSON.stringify(value)}`)
  }
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  // Reject impossible calendar dates like 2026-02-30, which the regex alone lets through.
  const roundTrip = toIsoDate(y, m, d)
  if (roundTrip !== value) {
    throw new RangeError(`Not a real calendar date: ${value}`)
  }
  return value as BusinessDate
}
