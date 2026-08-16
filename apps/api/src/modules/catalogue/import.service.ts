import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  CsvParseError,
  TEMPLATE_COLUMNS,
  detectColumnMapping,
  findInFileDuplicates,
  normalizeRow,
  parseCsv,
  toCsv,
  type ColumnMapping,
  type NormalizedRow,
  type ProductDraft,
  type RowIssue,
} from '@dukaano/business-logic'
import { MAX_IMPORT_ROWS, type DuplicateAction, type ImportCommitInput, type ImportPreviewInput } from '@dukaano/validation'
import { UNIT_CODES } from '@dukaano/types'
import { BusinessRuleError } from '../../common/errors/domain-error'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'
import { CategoriesService } from './categories.service'
import { ChangeLogService } from '../sync/change-log.service'
import { InventoryService } from '../inventory/inventory.service'

/**
 * Bulk product import (blueprint §6, journey J3).
 *
 * Two endpoints, no server-side job: **preview** tells the shopkeeper what will happen, **commit**
 * does it. Both re-parse and re-validate the uploaded text from scratch, so a tampered or stale
 * preview cannot influence what gets written (ADR-0006).
 *
 * The shape of the safety argument:
 *
 *   • Every row is validated **before anything is written**. Rows with errors are reported and
 *     never attempted.
 *   • Valid rows are then written inside the request's single tenant transaction, so the import
 *     is all-or-nothing. There is no state in which the shopkeeper has 3,000 of their 5,000
 *     products and no idea which.
 *   • Failure after validation is therefore genuinely exceptional — a concurrent write taking a
 *     SKU between preview and commit — and rolling back is the right answer to it.
 */

export type RowStatus = 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR'

export interface PreviewRow {
  readonly line: number
  readonly status: RowStatus
  readonly nameEn?: string
  readonly nameHi?: string
  readonly errors?: readonly RowIssue[]
  readonly warnings?: readonly RowIssue[]
  /** The product this row collides with, shown side by side so the choice is informed. */
  readonly duplicateOf?: {
    readonly id: string
    readonly field: 'sku' | 'shortCode'
    readonly value: string
    readonly nameEn: string | null
    readonly nameHi: string | null
    readonly sellingPricePaise: bigint
  }
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name)

  constructor(
    private readonly categories: CategoriesService,
    private readonly inventory: InventoryService,
    private readonly changeLog: ChangeLogService,
  ) {}

  /** The downloadable template: our header row plus one filled example line. */
  template(): string {
    const header = [...TEMPLATE_COLUMNS]
    const example = [
      'Sugar Loose', 'चीनी खुली', 'KG', '44.50', '40.00', '', '25', '5',
      'SUG01', 'S1', 'Staples', 'chini|cheeni|shakkar',
    ]
    return toCsv(header, [example])
  }

  /**
   * Step 2 and 3 of the wizard: what would happen if this file were imported?
   *
   * No writes. The shopkeeper sees a per-row verdict and resolves duplicates before committing.
   */
  async preview(shopId: string, input: ImportPreviewInput) {
    const { header, rows, mapping } = this.parse(input.content, input.mapping)

    const normalized = rows.map((row) =>
      normalizeRow(row, mapping, { defaultUnitCode: input.defaultUnitCode }),
    )
    const inFileDuplicates = findInFileDuplicates(normalized)
    const duplicateLines = new Set(inFileDuplicates.flatMap((collision) => collision.lines))

    const existingByCode = await this.findExistingByCode(shopId, normalized)

    const preview: PreviewRow[] = normalized.map((row) => {
      if (!row.ok) {
        return { line: row.line, status: 'ERROR', errors: row.errors }
      }

      // A collision *within the file* is a mistake in the file, not a choice to be made: importing
      // either of two rows claiming one SKU is a coin toss, so both are rejected.
      if (duplicateLines.has(row.line)) {
        return {
          line: row.line,
          status: 'ERROR',
          nameEn: row.draft.nameEn,
          nameHi: row.draft.nameHi,
          errors: [{ column: 'sku', messageKey: 'errors.import.duplicateInFile' }],
        }
      }

      const clash = this.findClash(row.draft, existingByCode)
      return {
        line: row.line,
        // Default to SKIP for a duplicate. Overwriting a live product's price because a
        // spreadsheet reused its SKU is not a default — the shopkeeper chooses per row.
        status: clash ? 'SKIP' : 'CREATE',
        nameEn: row.draft.nameEn,
        nameHi: row.draft.nameHi,
        warnings: row.warnings.length > 0 ? row.warnings : undefined,
        duplicateOf: clash,
      }
    })

    return {
      header,
      mapping,
      /** True when the client sent no mapping and this one was auto-detected for review. */
      mappingWasDetected: input.mapping === undefined,
      unmappedColumns: header
        .map((name, index) => ({ name, index }))
        .filter(({ index }) => !Object.values(mapping).includes(index)),
      unitCodes: UNIT_CODES,
      rows: preview,
      summary: this.summarize(preview),
    }
  }

  /**
   * Step 4: write it.
   *
   * Everything is validated first; only then does anything get written. See the class comment for
   * why that ordering, rather than per-row error recovery, is the safe design here.
   */
  async commit(shopId: string, input: ImportCommitInput) {
    const { rows, mapping } = this.parse(input.content, input.mapping)

    const normalized = rows.map((row) =>
      normalizeRow(row, mapping, { defaultUnitCode: input.defaultUnitCode }),
    )
    const inFileDuplicates = findInFileDuplicates(normalized)
    const duplicateLines = new Set(inFileDuplicates.flatMap((collision) => collision.lines))
    const existingByCode = await this.findExistingByCode(shopId, normalized)

    const decisions = input.decisions ?? {}
    const failed: { line: number; errors: readonly RowIssue[]; cells: readonly string[] }[] = []
    const toCreate: { draft: ProductDraft; line: number }[] = []
    const toUpdate: { draft: ProductDraft; line: number; productId: string }[] = []
    let skipped = 0

    for (const row of normalized) {
      if (!row.ok) {
        failed.push({ line: row.line, errors: row.errors, cells: row.cells })
        continue
      }

      if (duplicateLines.has(row.line)) {
        failed.push({
          line: row.line,
          errors: [{ column: 'sku', messageKey: 'errors.import.duplicateInFile' }],
          cells: rows.find((r) => r.line === row.line)?.cells ?? [],
        })
        continue
      }

      if (!input.acceptWarnings && row.warnings.length > 0) {
        failed.push({
          line: row.line,
          errors: row.warnings,
          cells: rows.find((r) => r.line === row.line)?.cells ?? [],
        })
        continue
      }

      const clash = this.findClash(row.draft, existingByCode)
      if (!clash) {
        toCreate.push({ draft: row.draft, line: row.line })
        continue
      }

      const action: DuplicateAction = decisions[String(row.line)] ?? 'SKIP'
      if (action === 'SKIP') {
        skipped++
      } else if (action === 'UPDATE') {
        toUpdate.push({ draft: row.draft, line: row.line, productId: clash.id })
      } else {
        // CREATE_ANYWAY: the shopkeeper wants both. The clashing code is dropped from the new
        // row rather than the import failing on the partial unique index — they asked for the
        // product, not for the code, and a hard failure at this point loses the whole batch.
        const draft = { ...row.draft }
        if (clash.field === 'sku') delete draft.sku
        else delete draft.shortCode
        toCreate.push({ draft, line: row.line })
      }
    }

    if (toCreate.length + toUpdate.length === 0) {
      return this.result(shopId, { created: 0, updated: 0, skipped, failed, mapping })
    }

    const created = await this.createProducts(shopId, toCreate)
    const updated = await this.updateProducts(toUpdate)

    this.logger.log(
      `Import into shop ${shopId}: ${created} created, ${updated} updated, ` +
        `${skipped} skipped, ${failed.length} failed`,
    )

    return this.result(shopId, { created, updated, skipped, failed, mapping })
  }

  // --- internals -------------------------------------------------------------------------------

  private parse(content: string, supplied?: ColumnMapping) {
    let document
    try {
      document = parseCsv(content)
    } catch (error) {
      if (error instanceof CsvParseError) {
        throw new BusinessRuleError(
          'CSV_PARSE_FAILED',
          'errors.import.parseFailed',
          { line: error.line },
          error.message,
        )
      }
      throw error
    }

    if (document.header.length === 0) {
      throw new BusinessRuleError('EMPTY_FILE', 'errors.import.fileEmpty')
    }
    if (document.rows.length > MAX_IMPORT_ROWS) {
      throw new BusinessRuleError('TOO_MANY_ROWS', 'errors.import.tooManyRows', {
        max: MAX_IMPORT_ROWS,
        received: document.rows.length,
      })
    }

    const mapping = supplied ?? detectColumnMapping(document.header)

    // Without a name column and a price column there is nothing importable, and letting the
    // shopkeeper reach the preview only to find every row red wastes their time.
    if (mapping.nameEn === undefined && mapping.nameHi === undefined) {
      throw new BusinessRuleError('NO_NAME_COLUMN', 'errors.import.nameColumnRequired')
    }
    if (mapping.sellingPrice === undefined) {
      throw new BusinessRuleError('NO_PRICE_COLUMN', 'errors.import.priceColumnRequired')
    }

    return { header: document.header, rows: document.rows, mapping }
  }

  /**
   * Look up every SKU and short code the file mentions, in one query per field.
   *
   * Two queries rather than 5,000. A per-row existence check is the obvious way to write this and
   * turns a two-second import into a four-minute one.
   */
  private async findExistingByCode(shopId: string, rows: readonly NormalizedRow[]) {
    const skus = new Set<string>()
    const shortCodes = new Set<string>()
    for (const row of rows) {
      if (!row.ok) continue
      if (row.draft.sku) skus.add(row.draft.sku.toLowerCase())
      if (row.draft.shortCode) shortCodes.add(row.draft.shortCode.toLowerCase())
    }

    const bySku = new Map<string, ExistingProduct>()
    const byShortCode = new Map<string, ExistingProduct>()
    if (skus.size === 0 && shortCodes.size === 0) return { bySku, byShortCode }

    const existing = await tenantClient().$queryRaw<ExistingProductRow[]>`
      SELECT id, sku, short_code AS "shortCode", name_en AS "nameEn", name_hi AS "nameHi",
             selling_price_paise AS "sellingPricePaise"
      FROM product
      WHERE shop_id = ${shopId}::uuid
        AND archived_at IS NULL
        AND (
          lower(sku)        = ANY(${[...skus]}::text[])
          OR lower(short_code) = ANY(${[...shortCodes]}::text[])
        )
    `

    for (const product of existing) {
      const entry: ExistingProduct = {
        id: product.id,
        nameEn: product.nameEn,
        nameHi: product.nameHi,
        sellingPricePaise: product.sellingPricePaise,
      }
      if (product.sku) bySku.set(product.sku.toLowerCase(), entry)
      if (product.shortCode) byShortCode.set(product.shortCode.toLowerCase(), entry)
    }

    return { bySku, byShortCode }
  }

  private findClash(
    draft: ProductDraft,
    existing: { bySku: Map<string, ExistingProduct>; byShortCode: Map<string, ExistingProduct> },
  ): PreviewRow['duplicateOf'] {
    if (draft.sku) {
      const match = existing.bySku.get(draft.sku.toLowerCase())
      if (match) return { ...match, field: 'sku', value: draft.sku }
    }
    if (draft.shortCode) {
      const match = existing.byShortCode.get(draft.shortCode.toLowerCase())
      if (match) return { ...match, field: 'shortCode', value: draft.shortCode }
    }
    return undefined
  }

  /** Bulk create, with categories resolved once per distinct name rather than per row. */
  private async createProducts(
    shopId: string,
    entries: readonly { draft: ProductDraft; line: number }[],
  ): Promise<number> {
    if (entries.length === 0) return 0

    const categoryIds = await this.resolveCategories(shopId, entries.map((entry) => entry.draft))
    const userId = currentContext()?.userId ?? null
    const tx = tenantClient()

    const products = entries.map(({ draft }) => ({
      id: randomUUID(),
      draft,
      categoryId: draft.categoryName ? categoryIds.get(draft.categoryName.toLowerCase()) : undefined,
    }))

    await tx.product.createMany({
      data: products.map(({ id, draft, categoryId }) => ({
        id,
        shopId,
        categoryId: categoryId ?? null,
        nameEn: draft.nameEn ?? null,
        nameHi: draft.nameHi ?? null,
        sku: draft.sku ?? null,
        shortCode: draft.shortCode ?? null,
        unitCode: draft.unitCode,
        sellingPricePaise: BigInt(draft.sellingPricePaise),
        purchasePricePaise:
          draft.purchasePricePaise !== undefined ? BigInt(draft.purchasePricePaise) : null,
        mrpPaise: draft.mrpPaise !== undefined ? BigInt(draft.mrpPaise) : null,
        lowStockThresholdMilli: BigInt(draft.lowStockThresholdMilli ?? 0),
        createdByUserId: userId,
        updatedByUserId: userId,
      })),
    })

    const aliasRows = products.flatMap(({ id, draft }) =>
      (draft.aliases ?? []).map((alias) => ({ id: randomUUID(), shopId, productId: id, alias })),
    )
    if (aliasRows.length > 0) {
      await tx.productAlias.createMany({ data: aliasRows, skipDuplicates: true })
    }

    // The bulk create bypasses ProductsService, so it must log its own changes — otherwise an
    // imported catalogue exists on the server and never reaches a single device (§14.5). One
    // statement for the whole batch; per-row inserts would dominate the import's runtime.
    await this.changeLog.recordMany(
      products.map(({ id }) => ({ entity: 'product' as const, entityId: id, op: 'upsert' as const, rowVersion: 1 })),
    )

    // Opening stock as OPENING_STOCK transactions (§17.2). Batched, which is safe here because
    // every product id was created in this same uncommitted transaction — see the method comment.
    await this.inventory.applyOpeningStockBatch(
      products.flatMap(({ id, draft }) =>
        draft.openingStockMilli !== undefined && draft.openingStockMilli > 0
          ? [
              {
                productId: id,
                qtyMilli: draft.openingStockMilli,
                unitCostPaise: draft.purchasePricePaise,
              },
            ]
          : [],
      ),
    )

    return products.length
  }

  /**
   * Apply an UPDATE decision.
   *
   * Deliberately narrow: prices, threshold and names only. Opening stock is **not** applied to an
   * existing product — that product already has a stock history, and treating a spreadsheet
   * column as opening stock would either double-count or silently overwrite a real balance. The
   * shopkeeper adjusts stock through the inventory path, where it leaves a reason and an actor.
   *
   * The unit is not updated either: changing a unit while stock is non-zero is blocked
   * everywhere else (§25 E-37), and an import must not be the one way around that rule.
   */
  private async updateProducts(
    entries: readonly { draft: ProductDraft; productId: string }[],
  ): Promise<number> {
    const userId = currentContext()?.userId ?? null
    const tx = tenantClient()

    const changed: string[] = []

    for (const { draft, productId } of entries) {
      changed.push(productId)
      await tx.product.update({
        where: { id: productId },
        data: {
          nameEn: draft.nameEn ?? undefined,
          nameHi: draft.nameHi ?? undefined,
          sellingPricePaise: BigInt(draft.sellingPricePaise),
          purchasePricePaise:
            draft.purchasePricePaise !== undefined ? BigInt(draft.purchasePricePaise) : undefined,
          mrpPaise: draft.mrpPaise !== undefined ? BigInt(draft.mrpPaise) : undefined,
          lowStockThresholdMilli:
            draft.lowStockThresholdMilli !== undefined
              ? BigInt(draft.lowStockThresholdMilli)
              : undefined,
          updatedByUserId: userId,
          rowVersion: { increment: 1n },
        },
      })
    }

    await this.changeLog.recordMany(
      changed.map((id) => ({ entity: 'product' as const, entityId: id, op: 'upsert' as const, rowVersion: 1 })),
    )

    return entries.length
  }

  private async resolveCategories(
    shopId: string,
    drafts: readonly ProductDraft[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    for (const draft of drafts) {
      if (draft.categoryName) names.set(draft.categoryName.toLowerCase(), draft.categoryName)
    }

    const resolved = new Map<string, string>()
    for (const [key, name] of names) {
      // Devanagari in the cell means they are working in Hindi; put the name in the Hindi column
      // so it renders correctly rather than sitting in an English field.
      const isHindi = /[ऀ-ॿ]/.test(name)
      resolved.set(key, await this.categories.findOrCreateByName(shopId, name, isHindi))
    }
    return resolved
  }

  private summarize(rows: readonly PreviewRow[]) {
    return {
      total: rows.length,
      create: rows.filter((row) => row.status === 'CREATE').length,
      duplicate: rows.filter((row) => row.status === 'SKIP').length,
      error: rows.filter((row) => row.status === 'ERROR').length,
      warning: rows.filter((row) => (row.warnings?.length ?? 0) > 0).length,
    }
  }

  /**
   * The commit result, including the failed rows as re-uploadable CSV.
   *
   * The failed-row file carries the original cells plus an `_error` column, so the shopkeeper
   * fixes the twelve broken rows in Excel and uploads that file directly instead of hunting for
   * them in the original 5,000.
   */
  private result(
    shopId: string,
    outcome: {
      created: number
      updated: number
      skipped: number
      failed: { line: number; errors: readonly RowIssue[]; cells: readonly string[] }[]
      mapping: ColumnMapping
    },
  ) {
    const width = Math.max(0, ...outcome.failed.map((row) => row.cells.length))
    const header = [
      '_line',
      ...Array.from({ length: width }, (_, index) => this.columnLabel(outcome.mapping, index)),
      '_error',
    ]

    const failedCsv =
      outcome.failed.length === 0
        ? null
        : toCsv(
            header,
            outcome.failed.map((row) => [
              String(row.line),
              ...Array.from({ length: width }, (_, index) => row.cells[index] ?? ''),
              row.errors.map((issue) => `${issue.column}: ${issue.messageKey}`).join('; '),
            ]),
          )

    return {
      shopId,
      createdCount: outcome.created,
      updatedCount: outcome.updated,
      skippedCount: outcome.skipped,
      failedCount: outcome.failed.length,
      failed: outcome.failed.map((row) => ({ line: row.line, errors: row.errors })),
      failedCsv,
    }
  }

  /** Name a column in the failed-row file by the field it was mapped to, if any. */
  private columnLabel(mapping: ColumnMapping, index: number): string {
    const entry = Object.entries(mapping).find(([, mapped]) => mapped === index)
    return entry ? entry[0] : `column${index + 1}`
  }
}

interface ExistingProduct {
  id: string
  nameEn: string | null
  nameHi: string | null
  sellingPricePaise: bigint
}

interface ExistingProductRow extends ExistingProduct {
  sku: string | null
  shortCode: string | null
}
