import { Controller, Get } from '@nestjs/common'
import { LOCALES, type Locale } from '@dukaano/types'
import { translate } from '@dukaano/i18n'
import { Public, SkipTenant } from './common/decorators'
import { PrismaService } from './common/prisma/prisma.service'

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @SkipTenant()
  @Get('health')
  async health() {
    await this.prisma.untenanted.$queryRaw`SELECT 1`
    return { status: 'ok', service: 'dukaano-api' }
  }

  /**
   * Proves the API renders in both locales — a Phase 1 acceptance criterion.
   *
   * Kept as a real endpoint rather than a test-only fixture because it is genuinely useful: it
   * confirms after any deploy that the Hindi catalogue was bundled and that Devanagari survives
   * the whole response path (encoding, headers, JSON serialization). A Hindi string mangled by a
   * misconfigured content type is exactly the kind of failure that reaches users unnoticed.
   */
  @Public()
  @SkipTenant()
  @Get('health/locales')
  locales() {
    return {
      supported: LOCALES,
      samples: Object.fromEntries(
        LOCALES.map((locale: Locale) => [
          locale,
          {
            tagline: translate(locale, 'common.tagline'),
            newSale: translate(locale, 'nav.newSale'),
            khata: translate(locale, 'nav.khata'),
            oneItem: translate(locale, 'count.items', { count: 1 }),
            manyItems: translate(locale, 'count.items', { count: 5 }),
            zeroItems: translate(locale, 'count.items', { count: 0 }),
          },
        ]),
      ),
    }
  }
}
