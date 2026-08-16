import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common'
import { LOCALES, type Locale } from '@dukaano/types'
import { translate } from '@dukaano/i18n'
import { Public, SkipTenant } from './common/decorators'
import { PrismaService } from './common/prisma/prisma.service'

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The service root.
   *
   * Exists because the alternative is worse: opening `http://localhost:3000/` in a browser — the
   * first thing anyone does after starting a server — returned a bare 404 in the API's error
   * envelope, which reads like something is broken rather than like "this is an API and you want a
   * different path". This says what the service is and where to go next.
   *
   * Deliberately lists no route table: an unauthenticated endpoint enumerating every path is a
   * gift to anyone probing the service, and the people who need the full list have the source.
   */
  @Public()
  @SkipTenant()
  @Get()
  root() {
    return {
      service: 'dukaano-api',
      description:
        'Dukaano API. There is no web UI on this port — the mobile and web clients are separate apps.',
      docs: 'docs/dukaano-blueprint.md',
      endpoints: {
        health: '/health',
        locales: '/health/locales',
        login: 'POST /v1/auth/login',
      },
    }
  }

  /**
   * Answer the browser's automatic favicon request with "nothing to see here".
   *
   * Every browser asks for this unprompted. Without the route it falls through to the 404 handler,
   * which puts a red error in the developer console of anyone who opens the API in a browser and a
   * 404 in the logs on every visit — noise that looks like a fault and is not one.
   *
   * 204 rather than an actual icon: this is an API, it has no brand surface, and shipping a binary
   * asset to silence a log line would be the wrong trade.
   */
  @Public()
  @SkipTenant()
  @Get('favicon.ico')
  @HttpCode(HttpStatus.NO_CONTENT)
  favicon(): void {}

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
