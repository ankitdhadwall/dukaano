import { describe, expect, it } from 'vitest'
import { asMilli, asPaise } from '@dukaano/money'
import {
  formatDate,
  formatDateLong,
  formatDateTime,
  formatMoney,
  formatMoneyPlain,
  formatPhone,
  formatQuantity,
  formatQuantityValue,
  maskPhone,
} from './formatters'

const p = asPaise
const m = asMilli

describe('formatMoney — Indian digit grouping', () => {
  it('groups in lakhs and crores, not thousands', () => {
    // The whole reason this goes through Intl rather than a hand-rolled grouping helper.
    expect(formatMoney(p(10000000), 'en')).toBe('₹1,00,000')
    expect(formatMoney(p(1000000000), 'en')).toBe('₹1,00,00,000')
    expect(formatMoney(p(12500075), 'en')).toBe('₹1,25,000.75')
  })

  it('hides paise on whole-rupee amounts by default', () => {
    // A shopkeeper reads ₹460 faster than ₹460.00, and most bills land on whole rupees.
    expect(formatMoney(p(46000), 'en')).toBe('₹460')
    expect(formatMoney(p(46050), 'en')).toBe('₹460.50')
    expect(formatMoney(p(0), 'en')).toBe('₹0')
  })

  it('shows paise when asked', () => {
    expect(formatMoney(p(46000), 'en', { compact: false })).toBe('₹460.00')
  })

  it('handles negative amounts (advances, refunds)', () => {
    expect(formatMoney(p(-46000), 'en')).toBe('-₹460')
  })

  it('uses Latin numerals in Hindi, never Devanagari digits', () => {
    // ₹१,२५० is technically correct Hindi and slower to read for essentially every user.
    const formatted = formatMoney(p(125000), 'hi')
    expect(formatted).toContain('1,250')
    expect(formatted).not.toMatch(/[०-९]/)
  })

  it('strips the symbol for table columns', () => {
    expect(formatMoneyPlain(p(12500075), 'en')).toBe('1,25,000.75')
  })
})

describe('formatQuantity', () => {
  it('trims trailing zeros so a receipt does not read "1.500 kg"', () => {
    expect(formatQuantity(m(1500), 'kg', 'en')).toBe('1.5 kg')
    expect(formatQuantity(m(1000), 'kg', 'en')).toBe('1 kg')
    expect(formatQuantity(m(750), 'kg', 'en')).toBe('0.75 kg')
    expect(formatQuantity(m(1), 'kg', 'en')).toBe('0.001 kg')
  })

  it('works with a Hindi unit label', () => {
    expect(formatQuantity(m(2500), 'किलो', 'hi')).toBe('2.5 किलो')
  })

  it('formats a bare value', () => {
    expect(formatQuantityValue(m(1250))).toBe('1.25')
    expect(formatQuantityValue(m(0))).toBe('0')
  })
})

describe('date formatting', () => {
  // 2026-08-16T19:00:00Z is 00:30 IST on the 17th — the case a naive UTC format gets wrong.
  const instant = new Date('2026-08-16T19:00:00Z')

  it('renders in the shop timezone, not UTC', () => {
    expect(formatDate(instant, 'en', 'Asia/Kolkata')).toBe('17/08/2026')
    expect(formatDate(instant, 'en', 'UTC')).toBe('16/08/2026')
  })

  it('uses dd/MM/yyyy, the Indian convention', () => {
    expect(formatDate(new Date('2026-03-05T06:00:00Z'), 'en')).toBe('05/03/2026')
  })

  it('renders a long date with a localized month', () => {
    const en = formatDateLong(new Date('2026-03-05T06:00:00Z'), 'en')
    const hi = formatDateLong(new Date('2026-03-05T06:00:00Z'), 'hi')
    expect(en).toMatch(/5 Mar 2026/)
    expect(hi).not.toBe(en)
    expect(hi).toMatch(/2026/)
  })

  it('renders date and time together', () => {
    const formatted = formatDateTime(new Date('2026-08-16T06:30:00Z'), 'en')
    expect(formatted).toMatch(/16\/08\/2026/)
    expect(formatted).toMatch(/12:00/) // 06:30 UTC = 12:00 IST
  })

  it('keeps Latin numerals in Hindi dates', () => {
    expect(formatDate(instant, 'hi')).not.toMatch(/[०-९]/)
  })
})

describe('phone formatting', () => {
  it('renders an Indian mobile readably', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210')
  })

  it('passes through anything it does not recognise rather than mangling it', () => {
    expect(formatPhone('+14155552671')).toBe('+14155552671')
    expect(formatPhone('')).toBe('')
  })

  it('masks for logs — customer phone numbers are PII (§23.4)', () => {
    expect(maskPhone('+919876543210')).toBe('+91 98XXX X3210')
    expect(maskPhone('+91 98765 43210')).toBe('+91 98XXX X3210')
  })

  it('never leaks digits from an unrecognised number', () => {
    expect(maskPhone('+14155552671')).toBe('+91XXXXXXXXXX')
    expect(maskPhone('garbage')).toBe('+91XXXXXXXXXX')
  })
})
