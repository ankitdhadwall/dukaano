import { describe, expect, it } from 'vitest'
import { parseMoneyInput, parseQuantityInput } from './parse'

/** Unwrap a successful parse, failing loudly otherwise. */
function value<T>(result: { ok: true; value: T } | { ok: false; errorKey: string }): T {
  if (!result.ok) throw new Error(`expected a successful parse, got ${result.errorKey}`)
  return result.value
}

/** Unwrap a failed parse. */
function errorKey(result: { ok: boolean; errorKey?: string }): string | undefined {
  return result.errorKey
}

describe('parseMoneyInput', () => {
  it.each([
    ['44', 4400, 'whole rupees'],
    ['44.5', 4450, 'one decimal is padded'],
    ['44.50', 4450, 'two decimals'],
    ['0', 0, 'zero'],
    ['0.01', 1, 'one paisa'],
    ['.5', 50, 'leading dot'],
    ['44.', 4400, 'trailing dot'],
    ['007', 700, 'leading zeros'],
    ['₹44.50', 4450, 'rupee sign is stripped'],
    ['1,25,000', 12500000, 'Indian digit grouping is stripped'],
    ['1,25,000.75', 12500075, 'grouping plus decimals'],
    ['  44.50  ', 4450, 'surrounding whitespace'],
    ['₹ 1,250.75', 125075, 'the way a shopkeeper actually pastes it'],
  ])('parses %s → %s paise (%s)', (input, expected) => {
    expect(value(parseMoneyInput(input))).toBe(expected)
  })

  it('never routes through float — 0.1 + 0.2 style drift is structurally impossible', () => {
    // 8.20 in float is 8.199999999999999; via string surgery it is exactly 820 paise.
    expect(value(parseMoneyInput('8.20'))).toBe(820)
    expect(value(parseMoneyInput('0.29'))).toBe(29)
    expect(value(parseMoneyInput('1.10'))).toBe(110)
    // Verify the float route really would have been wrong, so this test documents its own reason.
    expect(Math.round(Number('8.20') * 100)).toBe(820) // survives here…
    expect(Number('1.005') * 1000).not.toBe(1005) // …but not here: float gives 1004.9999999999999
  })

  it.each([
    ['44.555', 'errors.money.tooManyDecimals', 'three decimals — money carries two'],
    ['', 'errors.money.required', 'empty'],
    ['   ', 'errors.money.required', 'whitespace only'],
    ['abc', 'errors.money.invalid', 'letters'],
    ['4.4.4', 'errors.money.invalid', 'two decimal points'],
    ['4-4', 'errors.money.invalid', 'embedded sign'],
    ['.', 'errors.money.invalid', 'a bare dot has no digits'],
    ['-10', 'errors.money.invalid', 'negative not allowed by default'],
  ])('rejects %s with %s (%s)', (input, expected) => {
    const result = parseMoneyInput(input)
    expect(result.ok).toBe(false)
    expect(errorKey(result)).toBe(expected)
  })

  it('accepts negatives only when explicitly permitted (adjustments, reversals)', () => {
    expect(parseMoneyInput('-10').ok).toBe(false)
    expect(value(parseMoneyInput('-10', { allowNegative: true }))).toBe(-1000)
    expect(value(parseMoneyInput('-0.50', { allowNegative: true }))).toBe(-50)
    expect(parseMoneyInput('-', { allowNegative: true }).ok).toBe(false)
  })

  it('rejects a value too large to round-trip as a JSON number', () => {
    const result = parseMoneyInput('999999999999999999999')
    expect(result.ok).toBe(false)
    expect(errorKey(result)).toBe('errors.money.tooLarge')
  })

  it('reports how many decimals were received, so the UI can say something useful', () => {
    const result = parseMoneyInput('44.5555')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.params).toEqual({ max: 2, received: 4 })
  })

  it('defends against non-string input from untyped call sites', () => {
    expect(parseMoneyInput(null as unknown as string).ok).toBe(false)
    expect(parseMoneyInput(44 as unknown as string).ok).toBe(false)
  })
})

describe('parseQuantityInput', () => {
  it.each([
    ['1', 1000, 'one whole unit'],
    ['1.25', 1250, '1.25 kg'],
    ['0.750', 750, '750 g entered as kg'],
    ['0.75', 750, 'two decimals padded to three'],
    ['2.5', 2500, '2.5 litres'],
    ['0.001', 1, 'one gram'],
    ['100', 100000, 'a hundred pieces'],
  ])('parses %s → %s milli (%s)', (input, expected) => {
    expect(value(parseQuantityInput(input))).toBe(expected)
  })

  it('honours a unit that forbids decimals — "1.5 pieces" is rejected, not truncated', () => {
    expect(value(parseQuantityInput('3', 0))).toBe(3000)
    const result = parseQuantityInput('1.5', 0)
    expect(result.ok).toBe(false)
    expect(errorKey(result)).toBe('errors.quantity.tooManyDecimals')
  })

  it('lifts a lower-precision unit onto the canonical 10^-3 storage scale', () => {
    // A unit declaring 1 decimal place still stores milli-units.
    expect(value(parseQuantityInput('1.5', 1))).toBe(1500)
    expect(value(parseQuantityInput('1.25', 2))).toBe(1250)
  })

  it.each([
    ['1.2345', 'errors.quantity.tooManyDecimals'],
    ['', 'errors.quantity.required'],
    ['abc', 'errors.quantity.invalid'],
    ['-5', 'errors.quantity.invalid'],
  ])('rejects %s with %s', (input, expected) => {
    const result = parseQuantityInput(input)
    expect(result.ok).toBe(false)
    expect(errorKey(result)).toBe(expected)
  })

  it('allows negative quantities when asked (stock adjustments, returns)', () => {
    expect(value(parseQuantityInput('-2', 3, { allowNegative: true }))).toBe(-2000)
  })

  it.each([-1, 4, 1.5])('rejects the invalid unit precision %s', (decimals) => {
    const result = parseQuantityInput('1', decimals)
    expect(result.ok).toBe(false)
    expect(errorKey(result)).toBe('errors.quantity.invalidUnitPrecision')
  })

  it('rejects a quantity too large to round-trip as a JSON number', () => {
    expect(parseQuantityInput('999999999999999999999').ok).toBe(false)
  })
})
