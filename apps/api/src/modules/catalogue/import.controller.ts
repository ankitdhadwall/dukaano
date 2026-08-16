import { Body, Controller, Get, Header, Post } from '@nestjs/common'
import { Audit, CurrentShop, RequirePermission } from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import { importCommitSchema, importPreviewSchema } from '@dukaano/validation'
import type { ImportCommitInput, ImportPreviewInput } from '@dukaano/validation'
import { RawResponse } from '../../common/interceptors/response-envelope.interceptor'
import { LongTransaction } from '../../common/decorators'
import { ImportService } from './import.service'

/**
 * The four-step import wizard's server half (blueprint §6, journey J3).
 *
 *   1. Upload           — client-side; XLSX is converted to CSV in the browser (ADR-0006)
 *   2. Column mapping   — GET template, then POST preview with no mapping to get one detected
 *   3. Preview          — POST preview with the reviewed mapping; no writes
 *   4. Commit           — POST commit with per-row duplicate decisions
 *
 * Every route requires `product.import`, which a Cashier does not hold: an import can reprice a
 * whole catalogue in one request, and that is an owner-or-manager act.
 */
@Controller('v1/products/import')
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  /** The blank template, ready to fill in Excel. */
  @RequirePermission('product.import')
  @Get('template')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="dukaano-products-template.csv"')
  @RawResponse()
  template(): string {
    // A BOM, so Excel opens the Devanagari example row as Hindi rather than as mojibake.
    // Written as an escape: a literal BOM here is invisible and would look like a stray character.
    return `\uFEFF${this.imports.template()}`
  }

  /** Steps 2 and 3. Read-only: this endpoint writes nothing. */
  @RequirePermission('product.import')
  @Post('preview')
  preview(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(importPreviewSchema)) body: ImportPreviewInput,
  ) {
    return this.imports.preview(shopId, body)
  }

  /**
   * Step 4. Atomic: the whole file imports or none of it does.
   *
   * `@LongTransaction` because 5,000 rows will not finish inside the 15-second budget sized for a
   * counter sale, and a timeout mid-import would roll back work the shopkeeper waited for.
   */
  @RequirePermission('product.import')
  @Audit('product.imported', 'product')
  @LongTransaction(120_000)
  @Post('commit')
  commit(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(importCommitSchema)) body: ImportCommitInput,
  ) {
    return this.imports.commit(shopId, body)
  }
}
