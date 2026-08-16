/**
 * Errors raised by @dukaano/money.
 *
 * These are programmer errors, not user-facing domain errors: reaching one means a caller
 * bypassed validation or mixed up a unit. They carry an i18n `messageKey` anyway so that the
 * API's exception filter (blueprint §24) can render something sane if one ever escapes.
 */

export abstract class MoneyError extends Error {
  abstract readonly code: string
  abstract readonly messageKey: string

  protected constructor(message: string) {
    super(message)
    this.name = new.target.name
    // Preserve the prototype chain when compiled to ES5-era targets / across realms.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** A value was not a safe integer, or was not in the expected scaled representation. */
export class InvalidScaledValueError extends MoneyError {
  override readonly code = 'INVALID_SCALED_VALUE'
  override readonly messageKey = 'errors.money.invalidValue'

  constructor(
    readonly value: unknown,
    readonly expected: 'paise' | 'milli' | 'basisPoints' | 'step',
  ) {
    super(
      `Expected an integer ${expected} value within the safe-integer range, received: ${String(value)}`,
    )
  }
}

/** An arithmetic result fell outside the safe-integer range and cannot be transported as JSON. */
export class MoneyOverflowError extends MoneyError {
  override readonly code = 'MONEY_OVERFLOW'
  override readonly messageKey = 'errors.money.overflow'

  constructor(readonly result: bigint) {
    super(
      `Arithmetic result ${result.toString()} exceeds the safe-integer range ` +
        `(±${Number.MAX_SAFE_INTEGER}) and cannot be represented as a JSON number.`,
    )
  }
}

/** A divisor or rounding step was zero or negative. */
export class InvalidDivisorError extends MoneyError {
  override readonly code = 'INVALID_DIVISOR'
  override readonly messageKey = 'errors.money.invalidDivisor'

  constructor(readonly divisor: bigint | number) {
    super(`Divisor/step must be a positive integer, received: ${divisor.toString()}`)
  }
}

/** An allocation could not be performed (no weights, or all weights zero/negative). */
export class InvalidAllocationError extends MoneyError {
  override readonly code = 'INVALID_ALLOCATION'
  override readonly messageKey = 'errors.money.invalidAllocation'

  constructor(message: string) {
    super(message)
  }
}
