import { Injectable, type PipeTransform } from '@nestjs/common'
import type { ZodSchema } from 'zod'

/**
 * Validates a request body against a shared Zod schema from @dukaano/validation.
 *
 * Using the *same* schema the web and mobile forms use is the point (blueprint §11): a rule
 * tightened once cannot drift between the three surfaces. Zod failures are converted to a
 * ValidationError by the exception filter, which carries the per-field i18n keys through to the
 * client untranslated so the reader sees them in their own language.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    // parse() throws ZodError, which DomainExceptionFilter maps to a 400 carrying fieldErrors.
    return this.schema.parse(value)
  }
}
