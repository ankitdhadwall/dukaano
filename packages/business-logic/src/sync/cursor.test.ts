import { describe, expect, it } from 'vitest'
import {
  CHANGE_LOG_RETENTION_DAYS,
  PROCESSED_OPERATION_RETENTION_DAYS,
  SYNC_BACKOFF_MS,
  backoffDelayMs,
  decideBootstrap,
  formatCursor,
  isValidCursor,
  parseCursor,
} from './cursor'

const NOW = new Date('2026-08-16T10:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

describe('decideBootstrap', () => {
  it('requires a bootstrap when the device has never pulled', () => {
    expect(decideBootstrap({ cursor: null, lastPulledAt: null, now: NOW })).toEqual({
      required: true,
      reason: 'NO_CURSOR',
    })
  })

  it('requires a bootstrap when a cursor exists but no pull time does', () => {
    // Half-written device state. Bootstrapping is the safe reading of it.
    expect(decideBootstrap({ cursor: '4210', lastPulledAt: null, now: NOW })).toMatchObject({
      required: true,
      reason: 'NO_CURSOR',
    })
  })

  it('allows a delta pull for a device that synced this morning', () => {
    expect(
      decideBootstrap({ cursor: '4210', lastPulledAt: daysAgo(0.25), now: NOW }),
    ).toEqual({ required: false })
  })

  it('allows a delta pull just inside the retention window', () => {
    expect(
      decideBootstrap({ cursor: '4210', lastPulledAt: daysAgo(29.9), now: NOW }),
    ).toEqual({ required: false })
  })

  it('forces a bootstrap for a 45-day-stale device (blueprint §28 acceptance criterion)', () => {
    expect(decideBootstrap({ cursor: '4210', lastPulledAt: daysAgo(45), now: NOW })).toEqual({
      required: true,
      reason: 'CURSOR_EXPIRED',
    })
  })

  it('treats the retention edge itself as expired', () => {
    // Inclusive on purpose: a needless bootstrap costs one gzipped download, a missed change
    // costs a sale that never appears on the device.
    expect(
      decideBootstrap({ cursor: '4210', lastPulledAt: daysAgo(CHANGE_LOG_RETENTION_DAYS), now: NOW }),
    ).toMatchObject({ required: true, reason: 'CURSOR_EXPIRED' })
  })

  it('honours an overridden retention window', () => {
    expect(
      decideBootstrap({ cursor: '4210', lastPulledAt: daysAgo(8), now: NOW, retentionDays: 7 }),
    ).toMatchObject({ required: true })
    expect(
      decideBootstrap({ cursor: '4210', lastPulledAt: daysAgo(8), now: NOW, retentionDays: 30 }),
    ).toEqual({ required: false })
  })

  it('does not trip on a clock that reports a future pull time', () => {
    // A device whose clock ran ahead produces a negative age. That is a clock problem (E-26),
    // not a reason to re-download the whole catalogue.
    expect(
      decideBootstrap({ cursor: '4210', lastPulledAt: new Date(NOW.getTime() + 86_400_000), now: NOW }),
    ).toEqual({ required: false })
  })
})

describe('retention windows', () => {
  it('keeps processed operations longer than the change log', () => {
    /*
     * Not arbitrary. A device forced to bootstrap at 30 days may still hold un-pushed ops in its
     * outbox. If duplicate suppression expired on the same schedule, those queued sales would
     * become duplicable at exactly the moment they are most likely to be retried.
     */
    expect(PROCESSED_OPERATION_RETENTION_DAYS).toBeGreaterThan(CHANGE_LOG_RETENTION_DAYS)
  })
})

describe('backoffDelayMs', () => {
  it('starts at one second', () => {
    expect(backoffDelayMs(1)).toBe(1_000)
  })

  it('follows the blueprint schedule', () => {
    expect([1, 2, 3, 4, 5, 6].map(backoffDelayMs)).toEqual([...SYNC_BACKOFF_MS])
  })

  it('caps at five minutes rather than growing without bound', () => {
    expect(backoffDelayMs(7)).toBe(300_000)
    expect(backoffDelayMs(500)).toBe(300_000)
  })

  it('treats attempt zero or negative as the first attempt', () => {
    expect(backoffDelayMs(0)).toBe(1_000)
    expect(backoffDelayMs(-3)).toBe(1_000)
  })
})

describe('parseCursor', () => {
  it('reads the composite form', () => {
    expect(parseCursor('4210:99')).toEqual({ txid: 4210n, changeId: 99n })
  })

  it('treats a bare watermark as the inclusive start of that watermark', () => {
    /*
     * changeId 0 is what makes the bare form inclusive. A transaction sitting exactly at the
     * watermark was still in flight when the watermark was taken, so its rows have never been
     * served; every real change_log.id is greater than 0, so `id > 0` admits all of them.
     */
    expect(parseCursor('4210')).toEqual({ txid: 4210n, changeId: 0n })
  })

  it('round-trips through formatCursor', () => {
    const cursor = { txid: 4210n, changeId: 99n }
    expect(parseCursor(formatCursor(cursor))).toEqual(cursor)
  })

  it('formats a drained watermark as an inclusive cursor', () => {
    expect(formatCursor({ txid: 500n, changeId: 0n })).toBe('500:0')
    expect(parseCursor('500:0')).toEqual({ txid: 500n, changeId: 0n })
  })

  it('rejects malformed input', () => {
    expect(parseCursor('')).toBeNull()
    expect(parseCursor('abc')).toBeNull()
    expect(parseCursor('-1')).toBeNull()
    expect(parseCursor('12.5')).toBeNull()
    expect(parseCursor('1:2:3')).toBeNull()
    expect(parseCursor('1:')).toBeNull()
    expect(parseCursor(':1')).toBeNull()
    expect(parseCursor('1; DROP TABLE change_log')).toBeNull()
    expect(parseCursor(' 42 ')).toBeNull()
  })

  it('rejects a value past the 64-bit range', () => {
    expect(parseCursor('18446744073709551616')).toBeNull()
    expect(parseCursor('999999999999999999999')).toBeNull()
    expect(parseCursor('1:18446744073709551616')).toBeNull()
  })

  it('accepts the largest valid xid8', () => {
    expect(parseCursor('18446744073709551615')).toEqual({
      txid: 18446744073709551615n,
      changeId: 0n,
    })
  })
})

describe('isValidCursor', () => {
  it('accepts both forms', () => {
    expect(isValidCursor('1')).toBe(true)
    expect(isValidCursor('4210:99')).toBe(true)
  })

  it('rejects what parseCursor rejects', () => {
    expect(isValidCursor('')).toBe(false)
    expect(isValidCursor('1; DROP TABLE change_log')).toBe(false)
  })
})
