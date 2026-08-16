/**
 * A CSV reader for files a shopkeeper actually produces.
 *
 * Written by hand rather than pulled from npm for one reason that outweighs the convenience: the
 * same parse must run in the browser preview and on the server commit, and any disagreement
 * between them shows up as "the preview said 300 rows were fine and the import created 288".
 * One implementation, shared through this package, makes that class of bug impossible.
 *
 * RFC 4180 with the deviations real files have:
 *   • a UTF-8 BOM, which Excel writes by default and which otherwise becomes part of the first
 *     header name — the symptom is a mysteriously unmappable first column
 *   • CRLF, LF or CR line endings, mixed within one file
 *   • embedded newlines inside quoted fields (a product name pasted from a web page)
 *   • doubled quotes as an escape: "Britannia ""Good Day""" → Britannia "Good Day"
 *   • a trailing newline, which must not produce a final empty row
 *
 * Deliberately NOT handled: alternative delimiters. A semicolon-delimited file is a European
 * locale export and is not something a Himachal shopkeeper's Excel produces; guessing the
 * delimiter is a well-known source of silently mis-parsed files, and a wrong guess here would
 * misprice a whole catalogue.
 */

/** Zero-based row index within the data rows, plus the raw cells. */
export interface CsvRow {
  /** 1-based line number **as the shopkeeper sees it in Excel**, header being line 1. */
  readonly line: number
  readonly cells: readonly string[]
}

export interface CsvDocument {
  readonly header: readonly string[]
  readonly rows: readonly CsvRow[]
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message)
    this.name = 'CsvParseError'
  }
}

const BOM = '﻿'

/**
 * Parse CSV text into a header and data rows.
 *
 * Rows are returned with whatever cell count they had; padding or truncating here would hide a
 * misaligned file, and a misaligned file must be reported to the shopkeeper rather than silently
 * shifted by one column.
 */
export function parseCsv(text: string): CsvDocument {
  const input = text.startsWith(BOM) ? text.slice(BOM.length) : text

  // Each record carries the line it began on. A parallel array of start lines would need an
  // index-bounds fallback that can never fire, which is dead code the coverage gate would flag.
  const records: { startLine: number; cells: string[] }[] = []

  let cells: string[] = []
  let field = ''
  let inQuotes = false
  let line = 1
  let recordStartLine = 1
  let sawAnyChar = false

  const endField = (): void => {
    cells.push(field)
    field = ''
  }

  const endRecord = (): void => {
    endField()
    records.push({ startLine: recordStartLine, cells })
    cells = []
    recordStartLine = line
  }

  for (let i = 0; i < input.length; i++) {
    // charAt rather than input[i]: under `noUncheckedIndexedAccess` the index form is
    // `string | undefined` even though the loop bound guarantees otherwise, and charAt is typed
    // `string`. Same behaviour, no assertion.
    const char = input.charAt(i)

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote is a literal quote; a lone quote closes the field.
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        if (char === '\n') line++
        field += char
      }
      continue
    }

    if (char === '"' && field === '') {
      inQuotes = true
      sawAnyChar = true
      continue
    }

    if (char === ',') {
      endField()
      sawAnyChar = true
      continue
    }

    if (char === '\r' || char === '\n') {
      // Treat CRLF as one terminator; a lone CR (classic Mac) also terminates.
      if (char === '\r' && input[i + 1] === '\n') i++
      line++
      endRecord() // also sets recordStartLine to the line just entered
      sawAnyChar = false
      continue
    }

    field += char
    sawAnyChar = true
  }

  if (inQuotes) {
    throw new CsvParseError(
      'The file has an unclosed quote — a quoted value was never closed.',
      recordStartLine,
    )
  }

  // A trailing newline leaves an empty pending record; only flush if something was actually read.
  if (sawAnyChar || field !== '' || cells.length > 0) endRecord()

  const [headerRecord, ...dataRecords] = records
  if (!headerRecord) return { header: [], rows: [] }

  const header = headerRecord.cells.map((cell) => cell.trim())

  const rows: CsvRow[] = []
  for (const record of dataRecords) {
    // Skip rows that are entirely empty. Excel appends these constantly when a user has ever
    // clicked below their data, and reporting 400 "missing name" errors for them is noise that
    // buries the twelve real problems.
    if (record.cells.every((cell) => cell.trim() === '')) continue
    rows.push({ line: record.startLine, cells: record.cells })
  }

  return { header, rows }
}

/**
 * The columns the import understands.
 *
 * `aliases` are the header spellings auto-detection accepts, lowercased and stripped of
 * punctuation. Hindi spellings are included because a shopkeeper who works in Hindi will label
 * their own spreadsheet in Hindi, and forcing them to rename columns to English before importing
 * would make the Hindi-first promise hollow at the first bulk operation.
 */
export const IMPORT_COLUMNS = {
  nameEn: ['name', 'nameen', 'productname', 'englishname', 'item', 'itemname', 'product'],
  nameHi: ['namehi', 'hindiname', 'नाम', 'हिंदीनाम', 'वस्तु', 'सामान'],
  unitCode: ['unit', 'unitcode', 'uom', 'इकाई', 'यूनिट'],
  sellingPrice: ['sellingprice', 'price', 'rate', 'saleprice', 'mrpprice', 'दाम', 'कीमत', 'रेट'],
  purchasePrice: ['purchaseprice', 'costprice', 'cost', 'buyingprice', 'लागत', 'खरीदमूल्य'],
  mrp: ['mrp', 'maximumretailprice', 'एमआरपी'],
  openingStock: ['openingstock', 'stock', 'quantity', 'qty', 'stockqty', 'स्टॉक', 'मात्रा'],
  lowStockThreshold: ['lowstockthreshold', 'lowstock', 'reorderlevel', 'minstock', 'threshold'],
  sku: ['sku', 'code', 'productcode', 'itemcode'],
  shortCode: ['shortcode', 'quickcode', 'shortkey'],
  category: ['category', 'categoryname', 'group', 'श्रेणी', 'वर्ग'],
  aliases: ['aliases', 'alias', 'searchterms', 'keywords', 'othernames'],
} as const

export type ImportColumn = keyof typeof IMPORT_COLUMNS

export const IMPORT_COLUMN_KEYS = Object.keys(IMPORT_COLUMNS) as readonly ImportColumn[]

/** A mapping from our column names to the zero-based index in the uploaded file. */
export type ColumnMapping = Partial<Record<ImportColumn, number>>

/** Strip everything that varies between two people naming the same column. */
function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\(.*?\)/g, '') // "Price (₹)" → "price"
    .replace(/[\s_\-./₹*]/g, '')
    .trim()
}

/**
 * Guess which uploaded column is which.
 *
 * The shopkeeper always sees and can correct this in step 2 of the wizard — auto-detection saves
 * them work, it does not decide anything. That is why an ambiguous header is left unmapped rather
 * than assigned to a best guess: an unmapped column is one dropdown to fix, whereas a wrong guess
 * that maps "cost" to selling price silently reprices the entire catalogue at cost, and the
 * shopkeeper has no reason to look for it.
 *
 * First match wins, so a file with both "Price" and "Purchase Price" maps each to its own column
 * rather than letting the looser alias win twice.
 */
export function detectColumnMapping(header: readonly string[]): ColumnMapping {
  const normalized = header.map(normalizeHeader)
  const mapping: ColumnMapping = {}
  const claimed = new Set<number>()

  // Exact matches first across all columns, then the remaining columns against what is left.
  for (const key of IMPORT_COLUMN_KEYS) {
    const aliases = IMPORT_COLUMNS[key] as readonly string[]
    const index = normalized.findIndex(
      (candidate, i) => !claimed.has(i) && candidate !== '' && aliases.includes(candidate),
    )
    if (index !== -1) {
      mapping[key] = index
      claimed.add(index)
    }
  }

  return mapping
}

/** The header row of the downloadable template, in the order the wizard documents. */
export const TEMPLATE_COLUMNS: readonly ImportColumn[] = [
  'nameEn',
  'nameHi',
  'unitCode',
  'sellingPrice',
  'purchasePrice',
  'mrp',
  'openingStock',
  'lowStockThreshold',
  'sku',
  'shortCode',
  'category',
  'aliases',
]

/** Quote a value for CSV output, per RFC 4180. */
export function toCsvValue(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Serialize rows to CSV text. Used for the template and the failed-row download. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header.map(toCsvValue).join(',')]
  for (const row of rows) lines.push(row.map(toCsvValue).join(','))
  // Excel on Windows needs CRLF to open a downloaded file without mangling it.
  return `${lines.join('\r\n')}\r\n`
}
