import { parseMoneyInput, parseQuantityInput } from '@dukaano/money'
import { UNIT_DEFINITIONS, type UnitCode } from '@dukaano/types'
import type { ColumnMapping, CsvRow, ImportColumn } from './csv'

/**
 * Turning a spreadsheet row into a product draft.
 *
 * This is the layer where a file full of human typing becomes integers. Everything here is pure,
 * so the browser preview and the server commit reach identical verdicts — the shopkeeper is never
 * shown a green row that then fails on import.
 *
 * The distinction that shapes the whole module:
 *
 *   **error**   — the row cannot be imported. Red. Nothing is created.
 *   **warning** — the row will import exactly as written, but it looks like a mistake. Amber.
 *
 * Warnings exist because the alternative is worse in both directions. Treat "selling price below
 * cost" as an error and you block the shopkeeper clearing old stock at a loss, which is a real
 * thing they do. Say nothing and a misplaced decimal ships 400 products priced at a tenth of
 * their value, discovered a fortnight later in the profit report.
 */

export interface ProductDraft {
  nameEn?: string
  nameHi?: string
  sku?: string
  shortCode?: string
  categoryName?: string
  unitCode: UnitCode
  sellingPricePaise: number
  purchasePricePaise?: number
  mrpPaise?: number
  lowStockThresholdMilli?: number
  openingStockMilli?: number
  aliases?: string[]
}

export interface RowIssue {
  /** Which import column it concerns, or `row` for whole-row problems. */
  readonly column: ImportColumn | 'row'
  /** An i18n key — never prose. The client renders it in the reader's language (§24.1). */
  readonly messageKey: string
  readonly params?: Record<string, unknown>
}

export type NormalizedRow =
  | {
      readonly ok: true
      readonly line: number
      readonly draft: ProductDraft
      readonly warnings: readonly RowIssue[]
    }
  | {
      readonly ok: false
      readonly line: number
      readonly errors: readonly RowIssue[]
      /** The raw cells, so a failed row can be written back out for re-upload. */
      readonly cells: readonly string[]
    }

export interface NormalizeOptions {
  /**
   * Unit for rows whose unit cell is blank, or for a file with no unit column at all.
   *
   * There is no built-in default. A file without units is ambiguous in a way that silently
   * corrupts quantities — importing 50 as PIECE when the shopkeeper meant KG is undetectable
   * afterwards — so the wizard makes them choose, and an unmapped unit column with no choice made
   * is an error on every row rather than a guess.
   */
  readonly defaultUnitCode?: UnitCode
}

/**
 * Unit spellings that appear in real files, mapped to our codes.
 *
 * Includes Devanagari and the abbreviations people actually type. A unit that is not recognised is
 * an error naming the value, never a fallback — see `defaultUnitCode` above.
 */
const UNIT_SYNONYMS: Readonly<Record<string, UnitCode>> = {
  pc: 'PIECE', pcs: 'PIECE', piece: 'PIECE', pieces: 'PIECE', nos: 'PIECE', no: 'PIECE',
  unit: 'PIECE', 'नग': 'PIECE', 'पीस': 'PIECE',
  pkt: 'PACKET', packet: 'PACKET', pack: 'PACKET', 'पैकेट': 'PACKET',
  box: 'BOX', carton: 'BOX', 'डिब्बा': 'BOX', 'बॉक्स': 'BOX',
  dz: 'DOZEN', doz: 'DOZEN', dozen: 'DOZEN', 'दर्जन': 'DOZEN',
  btl: 'BOTTLE', bottle: 'BOTTLE', 'बोतल': 'BOTTLE',
  bag: 'BAG', sack: 'BAG', 'बोरी': 'BAG', 'थैला': 'BAG',
  kg: 'KG', kgs: 'KG', kilo: 'KG', kilos: 'KG', kilogram: 'KG', 'किलो': 'KG', 'किग्रा': 'KG',
  g: 'GRAM', gm: 'GRAM', gms: 'GRAM', gram: 'GRAM', grams: 'GRAM', 'ग्राम': 'GRAM',
  l: 'LITRE', ltr: 'LITRE', lt: 'LITRE', litre: 'LITRE', liter: 'LITRE', 'लीटर': 'LITRE',
  ml: 'ML', mls: 'ML', millilitre: 'ML', 'मिलीलीटर': 'ML',
  m: 'METRE', mtr: 'METRE', metre: 'METRE', meter: 'METRE', 'मीटर': 'METRE',
}

/** Resolve a written unit to a code, accepting our own codes case-insensitively. */
export function resolveUnitCode(raw: string): UnitCode | undefined {
  const cleaned = raw.trim().toLowerCase().replace(/[.\s]/g, '')
  if (cleaned === '') return undefined
  const upper = cleaned.toUpperCase()
  if (upper in UNIT_DEFINITIONS) return upper as UnitCode
  return UNIT_SYNONYMS[cleaned]
}

/** Aliases arrive as one cell. Accept the three separators people use, and de-duplicate. */
export function splitAliases(raw: string): string[] {
  const parts = raw
    .split(/[|;,]/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0 && part.length <= 60)
  return [...new Set(parts)].slice(0, 20)
}

/** Normalize one spreadsheet row into a draft, or into the reasons it cannot be imported. */
export function normalizeRow(
  row: CsvRow,
  mapping: ColumnMapping,
  options: NormalizeOptions = {},
): NormalizedRow {
  const errors: RowIssue[] = []
  const warnings: RowIssue[] = []

  const cell = (column: ImportColumn): string => {
    const index = mapping[column]
    if (index === undefined) return ''
    return (row.cells[index] ?? '').trim()
  }

  const fail = (): NormalizedRow => ({ ok: false, line: row.line, errors, cells: row.cells })

  // --- names ---------------------------------------------------------------------------------
  const nameEn = cell('nameEn').slice(0, 120)
  const nameHi = cell('nameHi').slice(0, 120)
  if (nameEn === '' && nameHi === '') {
    errors.push({ column: 'nameEn', messageKey: 'errors.product.nameRequired' })
  }

  // --- unit ----------------------------------------------------------------------------------
  const unitRaw = cell('unitCode')
  let unitCode: UnitCode | undefined
  if (unitRaw === '') {
    unitCode = options.defaultUnitCode
    if (!unitCode) {
      errors.push({ column: 'unitCode', messageKey: 'errors.import.unitRequired' })
    }
  } else {
    unitCode = resolveUnitCode(unitRaw)
    if (!unitCode) {
      errors.push({
        column: 'unitCode',
        messageKey: 'errors.product.invalidUnit',
        params: { unit: unitRaw },
      })
    }
  }

  // --- money ---------------------------------------------------------------------------------
  const sellingRaw = cell('sellingPrice')
  let sellingPricePaise: number | undefined
  if (sellingRaw === '') {
    errors.push({ column: 'sellingPrice', messageKey: 'errors.import.priceRequired' })
  } else {
    const parsed = parseMoneyInput(sellingRaw)
    if (parsed.ok) sellingPricePaise = parsed.value
    else errors.push({ column: 'sellingPrice', messageKey: parsed.errorKey, params: parsed.params })
  }

  const purchasePricePaise = optionalMoney(cell('purchasePrice'), 'purchasePrice', errors)
  const mrpPaise = optionalMoney(cell('mrp'), 'mrp', errors)

  // --- quantities ----------------------------------------------------------------------------
  // Quantity precision depends on the unit, so a row with an unresolved unit cannot have its
  // quantities checked. Reporting "invalid quantity" alongside "invalid unit" would send the
  // shopkeeper chasing a second problem that does not exist.
  let openingStockMilli: number | undefined
  let lowStockThresholdMilli: number | undefined
  if (unitCode) {
    const decimals = UNIT_DEFINITIONS[unitCode].decimals
    openingStockMilli = optionalQuantity(cell('openingStock'), decimals, 'openingStock', errors)
    lowStockThresholdMilli = optionalQuantity(
      cell('lowStockThreshold'),
      decimals,
      'lowStockThreshold',
      errors,
    )
  }

  // The two required values, checked first so the rest of this function has them narrowed.
  // Every path that leaves either undefined has already pushed the error explaining why.
  if (unitCode === undefined || sellingPricePaise === undefined) return fail()
  if (errors.length > 0) return fail()

  // --- warnings: importable, but worth a second look ------------------------------------------
  if (purchasePricePaise !== undefined && sellingPricePaise < purchasePricePaise) {
    warnings.push({ column: 'sellingPrice', messageKey: 'warnings.import.sellingBelowCost' })
  }

  if (mrpPaise !== undefined && mrpPaise < sellingPricePaise) {
    warnings.push({ column: 'mrp', messageKey: 'warnings.import.sellingAboveMrp' })
  }

  if (openingStockMilli !== undefined && openingStockMilli > 0 && purchasePricePaise === undefined) {
    // Stock with no cost basis values at zero, so the valuation and every profit figure that
    // reads it will understate until a purchase is recorded. Cheap to fix now, invisible later.
    warnings.push({ column: 'purchasePrice', messageKey: 'warnings.import.stockWithoutCost' })
  }

  const draft: ProductDraft = { unitCode, sellingPricePaise }
  if (nameEn !== '') draft.nameEn = nameEn
  if (nameHi !== '') draft.nameHi = nameHi
  if (purchasePricePaise !== undefined) draft.purchasePricePaise = purchasePricePaise
  if (mrpPaise !== undefined) draft.mrpPaise = mrpPaise
  if (openingStockMilli !== undefined) draft.openingStockMilli = openingStockMilli
  if (lowStockThresholdMilli !== undefined) draft.lowStockThresholdMilli = lowStockThresholdMilli

  const sku = cell('sku').slice(0, 40)
  if (sku !== '') draft.sku = sku
  const shortCode = cell('shortCode').slice(0, 20)
  if (shortCode !== '') draft.shortCode = shortCode
  const categoryName = cell('category').slice(0, 80)
  if (categoryName !== '') draft.categoryName = categoryName
  const aliases = splitAliases(cell('aliases'))
  if (aliases.length > 0) draft.aliases = aliases

  return { ok: true, line: row.line, draft, warnings }
}

function optionalMoney(
  raw: string,
  column: ImportColumn,
  errors: RowIssue[],
): number | undefined {
  if (raw === '') return undefined
  const parsed = parseMoneyInput(raw)
  if (parsed.ok) return parsed.value
  errors.push({ column, messageKey: parsed.errorKey, params: parsed.params })
  return undefined
}

function optionalQuantity(
  raw: string,
  decimals: number,
  column: ImportColumn,
  errors: RowIssue[],
): number | undefined {
  if (raw === '') return undefined
  const parsed = parseQuantityInput(raw, decimals)
  if (parsed.ok) return parsed.value
  errors.push({ column, messageKey: parsed.errorKey, params: parsed.params })
  return undefined
}

/**
 * Find rows that duplicate a SKU or short code **within the same file**.
 *
 * This is separate from the check against existing products because it needs a different remedy:
 * a clash with the database is resolved per row (skip / update / create anyway), whereas two rows
 * in one file claiming the same SKU is a mistake in the file, and importing either one is a coin
 * toss. Both rows are flagged, so the shopkeeper sees the pair rather than one arbitrary victim.
 *
 * Returns the set of line numbers involved, keyed by the code they collide on.
 */
export function findInFileDuplicates(
  rows: readonly NormalizedRow[],
): { readonly field: 'sku' | 'shortCode'; readonly value: string; readonly lines: number[] }[] {
  const collisions: { field: 'sku' | 'shortCode'; value: string; lines: number[] }[] = []

  for (const field of ['sku', 'shortCode'] as const) {
    const seen = new Map<string, number[]>()
    for (const row of rows) {
      if (!row.ok) continue
      const value = row.draft[field]
      if (!value) continue
      const key = value.toLowerCase()
      const lines = seen.get(key)
      if (lines) lines.push(row.line)
      else seen.set(key, [row.line])
    }
    for (const [value, lines] of seen) {
      if (lines.length > 1) collisions.push({ field, value, lines })
    }
  }

  return collisions
}
