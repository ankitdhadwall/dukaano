import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TRUSTED_CLOCK_SKEW_MS,
  addDays,
  computeBusinessDate,
  parseBusinessDate,
  resolveBusinessTimestamp,
  todayFor,
  type BusinessDate,
} from './business-date'

const IST = 'Asia/Kolkata'
const d = (iso: string) => new Date(iso)
const bd = (s: string) => s as BusinessDate

describe('computeBusinessDate — timezone', () => {
  it.each([
    // IST is UTC+5:30, so the date rolls over at 18:30 UTC.
    ['2026-08-16T06:00:00Z', '2026-08-16', '11:30 IST, same day'],
    ['2026-08-16T18:29:59Z', '2026-08-16', '23:59:59 IST — still the 16th'],
    ['2026-08-16T18:30:00Z', '2026-08-17', '00:00 IST — the 17th has begun'],
    ['2026-08-16T20:00:00Z', '2026-08-17', '01:30 IST on the 17th'],
    ['2026-08-16T00:00:00Z', '2026-08-16', '05:30 IST'],
  ])('%s in IST → %s (%s)', (instant, expected) => {
    expect(computeBusinessDate(d(instant), IST)).toBe(expected)
  })

  it('a sale at 23:45 IST is NOT tomorrow, which naive UTC dating would get wrong', () => {
    const instant = d('2026-08-16T18:15:00Z') // 23:45 IST on the 16th
    expect(instant.toISOString().slice(0, 10)).toBe('2026-08-16')
    expect(computeBusinessDate(instant, IST)).toBe('2026-08-16')

    // …and the converse: 00:30 IST on the 17th is 19:00 UTC on the 16th.
    const afterMidnight = d('2026-08-16T19:00:00Z')
    expect(afterMidnight.toISOString().slice(0, 10)).toBe('2026-08-16')
    expect(computeBusinessDate(afterMidnight, IST)).toBe('2026-08-17')
  })

  it('works for other zones, so the architecture is not IST-only', () => {
    expect(computeBusinessDate(d('2026-08-16T23:00:00Z'), 'UTC')).toBe('2026-08-16')
    expect(computeBusinessDate(d('2026-08-16T23:00:00Z'), 'America/New_York')).toBe('2026-08-16')
    expect(computeBusinessDate(d('2026-08-16T04:00:00Z'), 'America/New_York')).toBe('2026-08-16')
    expect(computeBusinessDate(d('2026-08-16T03:00:00Z'), 'America/New_York')).toBe('2026-08-15')
  })

  it('rolls month and year boundaries correctly', () => {
    expect(computeBusinessDate(d('2026-08-31T19:00:00Z'), IST)).toBe('2026-09-01')
    expect(computeBusinessDate(d('2026-12-31T19:00:00Z'), IST)).toBe('2027-01-01')
    // Leap year: 2028 is a leap year, so 29 Feb exists.
    expect(computeBusinessDate(d('2028-02-28T19:00:00Z'), IST)).toBe('2028-02-29')
  })
})

describe('computeBusinessDate — business day boundary (late-night shops)', () => {
  it('files a 01:00 IST sale under the previous day when the day starts at 04:00', () => {
    const oneAm = d('2026-08-16T19:30:00Z') // 01:00 IST on the 17th
    expect(computeBusinessDate(oneAm, IST, 0)).toBe('2026-08-17')
    expect(computeBusinessDate(oneAm, IST, 4)).toBe('2026-08-16')
  })

  it('rolls the day over exactly at the configured hour', () => {
    const justBefore = d('2026-08-16T22:29:00Z') // 03:59 IST
    const justAfter = d('2026-08-16T22:31:00Z') // 04:01 IST
    expect(computeBusinessDate(justBefore, IST, 4)).toBe('2026-08-16')
    expect(computeBusinessDate(justAfter, IST, 4)).toBe('2026-08-17')
  })

  it.each([-1, 24, 1.5, NaN])('rejects the invalid start hour %s', (hour) => {
    expect(() => computeBusinessDate(d('2026-08-16T06:00:00Z'), IST, hour)).toThrow(RangeError)
  })

  it('rejects an invalid Date rather than producing "NaN-NaN-NaN"', () => {
    expect(() => computeBusinessDate(new Date('nonsense'), IST)).toThrow(RangeError)
  })

  it('rejects an unknown timezone', () => {
    expect(() => computeBusinessDate(d('2026-08-16T06:00:00Z'), 'Mars/Olympus')).toThrow()
  })

  it('fails loudly if the runtime returns incomplete Intl parts', () => {
    // React Native's Hermes engine ships its own Intl implementation, and older builds have
    // returned partial `formatToParts` output for some zones. Silently reading `undefined`
    // there would produce a business date of "NaN-NaN-NaN" and file sales into a date no
    // report can ever show — so the guard throws instead. This test pins that behaviour.
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockReturnValue([{ type: 'year', value: '2026' }])

    try {
      expect(() => computeBusinessDate(d('2026-08-16T06:00:00Z'), IST)).toThrow(
        /Could not read "month"/,
      )
    } finally {
      spy.mockRestore()
    }
  })
})

describe('resolveBusinessTimestamp — device clock skew', () => {
  const server = d('2026-08-16T12:00:00Z')

  it('honours a genuinely backdated offline sale', () => {
    // Device was offline for six hours; the sale really did happen six hours ago.
    const client = d('2026-08-16T06:00:00Z')
    const result = resolveBusinessTimestamp(client, server)
    expect(result.occurredAt).toEqual(client)
    expect(result.clockSkewExceeded).toBe(false)
    expect(result.skewMs).toBe(-6 * 60 * 60 * 1000)
  })

  it('falls back to server time when the device clock is simply wrong', () => {
    // A factory-reset phone reporting 1970 would otherwise file today's takings into a business
    // date no report will ever display, making the money appear to vanish.
    const client = d('1970-01-01T00:00:00Z')
    const result = resolveBusinessTimestamp(client, server)
    expect(result.occurredAt).toEqual(server)
    expect(result.clockSkewExceeded).toBe(true)
  })

  it('flags a future-dated clock too', () => {
    const client = d('2027-08-16T12:00:00Z')
    const result = resolveBusinessTimestamp(client, server)
    expect(result.occurredAt).toEqual(server)
    expect(result.clockSkewExceeded).toBe(true)
    expect(result.skewMs).toBeGreaterThan(0)
  })

  it('treats exactly the threshold as still trusted, and one millisecond past it as not', () => {
    const atThreshold = new Date(server.getTime() - MAX_TRUSTED_CLOCK_SKEW_MS)
    const pastThreshold = new Date(server.getTime() - MAX_TRUSTED_CLOCK_SKEW_MS - 1)
    expect(resolveBusinessTimestamp(atThreshold, server).clockSkewExceeded).toBe(false)
    expect(resolveBusinessTimestamp(pastThreshold, server).clockSkewExceeded).toBe(true)
  })

  it('accepts a custom tolerance', () => {
    const client = d('2026-08-16T11:00:00Z')
    expect(resolveBusinessTimestamp(client, server, 30 * 60 * 1000).clockSkewExceeded).toBe(true)
    expect(resolveBusinessTimestamp(client, server, 2 * 60 * 60 * 1000).clockSkewExceeded).toBe(false)
  })
})

describe('addDays', () => {
  it.each([
    ['2026-08-16', 1, '2026-08-17'],
    ['2026-08-16', -1, '2026-08-15'],
    ['2026-08-31', 1, '2026-09-01'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2026-08-16', 0, '2026-08-16'],
    ['2026-08-16', 30, '2026-09-15'],
  ])('%s + %s days → %s', (date, days, expected) => {
    expect(addDays(bd(date), days)).toBe(expected)
  })

  it('rejects a malformed date', () => {
    expect(() => addDays(bd('nonsense'), 1)).toThrow(RangeError)
  })
})

describe('parseBusinessDate', () => {
  it.each(['2026-08-16', '2026-01-01', '2028-02-29'])('accepts %s', (value) => {
    expect(parseBusinessDate(value)).toBe(value)
  })

  it.each([
    ['2026-02-30', 'a date that does not exist'],
    ['2026-13-01', 'month 13'],
    ['2026-8-16', 'unpadded month'],
    ['16-08-2026', 'wrong order'],
    ['', 'empty'],
    [null, 'null'],
    [20260816, 'a number'],
  ])('rejects %s (%s)', (value) => {
    expect(() => parseBusinessDate(value)).toThrow(RangeError)
  })
})

describe('todayFor', () => {
  it('resolves today in the shop timezone from an injected clock', () => {
    expect(todayFor(IST, 0, d('2026-08-16T19:00:00Z'))).toBe('2026-08-17')
    expect(todayFor(IST, 4, d('2026-08-16T19:00:00Z'))).toBe('2026-08-16')
  })

  it('defaults to the real clock and returns a well-formed date', () => {
    expect(todayFor(IST)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
