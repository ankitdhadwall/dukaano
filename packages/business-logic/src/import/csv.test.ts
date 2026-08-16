import { describe, expect, it } from 'vitest'
import {
  CsvParseError,
  IMPORT_COLUMN_KEYS,
  TEMPLATE_COLUMNS,
  detectColumnMapping,
  parseCsv,
  toCsv,
  toCsvValue,
} from './csv'

describe('parseCsv', () => {
  it('parses a plain file into a header and rows', () => {
    const doc = parseCsv('Name,Price\nSugar,44\nRice,60\n')

    expect(doc.header).toEqual(['Name', 'Price'])
    expect(doc.rows).toEqual([
      { line: 2, cells: ['Sugar', '44'] },
      { line: 3, cells: ['Rice', '60'] },
    ])
  })

  it('reports line numbers as the shopkeeper sees them in Excel', () => {
    // The header is line 1, so the first data row must be line 2 — a report that says "row 1 is
    // invalid" sends them to the header.
    const doc = parseCsv('Name,Price\nSugar,44')
    expect(doc.rows[0]?.line).toBe(2)
  })

  it('strips the UTF-8 BOM Excel writes, which would otherwise corrupt the first header', () => {
    const doc = parseCsv('﻿Name,Price\nSugar,44\n')
    expect(doc.header[0]).toBe('Name')
  })

  it.each([
    ['CRLF', 'Name,Price\r\nSugar,44\r\n'],
    ['LF', 'Name,Price\nSugar,44\n'],
    ['CR', 'Name,Price\rSugar,44\r'],
    ['mixed', 'Name,Price\r\nSugar,44\n'],
  ])('handles %s line endings', (_label, text) => {
    const doc = parseCsv(text)
    expect(doc.header).toEqual(['Name', 'Price'])
    expect(doc.rows).toHaveLength(1)
    expect(doc.rows[0]?.cells).toEqual(['Sugar', '44'])
  })

  it('does not emit a phantom final row for a trailing newline', () => {
    expect(parseCsv('Name\nSugar\n').rows).toHaveLength(1)
  })

  it('parses a file with no trailing newline', () => {
    expect(parseCsv('Name\nSugar').rows).toHaveLength(1)
  })

  it('unquotes quoted fields and keeps embedded commas', () => {
    const doc = parseCsv('Name,Note\n"Sugar, loose",fine\n')
    expect(doc.rows[0]?.cells).toEqual(['Sugar, loose', 'fine'])
  })

  it('treats a doubled quote as one literal quote', () => {
    const doc = parseCsv('Name\n"Britannia ""Good Day"""\n')
    expect(doc.rows[0]?.cells).toEqual(['Britannia "Good Day"'])
  })

  it('keeps newlines inside a quoted field and still counts lines correctly afterwards', () => {
    const doc = parseCsv('Name,Note\n"Sugar\nloose",a\nRice,b\n')

    expect(doc.rows[0]?.cells).toEqual(['Sugar\nloose', 'a'])
    // Rice is on the *fourth* physical line because the quoted value spanned two.
    expect(doc.rows[1]?.line).toBe(4)
  })

  it('keeps a quote that appears mid-field as a literal character', () => {
    const doc = parseCsv('Name\n5" pipe\n')
    expect(doc.rows[0]?.cells).toEqual(['5" pipe'])
  })

  it('preserves empty trailing cells rather than shortening the row', () => {
    expect(parseCsv('A,B,C\n1,,\n').rows[0]?.cells).toEqual(['1', '', ''])
  })

  it('skips rows that are entirely blank', () => {
    // Excel appends these whenever a user has clicked below their data. Reporting them as errors
    // buries the real problems.
    const doc = parseCsv('Name,Price\nSugar,44\n,\n   ,  \nRice,60\n')
    expect(doc.rows.map((r) => r.cells[0])).toEqual(['Sugar', 'Rice'])
  })

  it('does NOT pad or truncate a misaligned row', () => {
    // Silently shifting a short row by one column would misprice the product with no trace.
    const doc = parseCsv('A,B,C\n1,2\n')
    expect(doc.rows[0]?.cells).toEqual(['1', '2'])
  })

  it('trims whitespace from header names but not from data cells', () => {
    const doc = parseCsv(' Name , Price \n Sugar ,44\n')
    expect(doc.header).toEqual(['Name', 'Price'])
    expect(doc.rows[0]?.cells[0]).toBe(' Sugar ')
  })

  it('throws a located error for an unclosed quote', () => {
    expect(() => parseCsv('Name\n"Sugar\n')).toThrow(CsvParseError)
    try {
      parseCsv('Name,Note\nSugar,ok\n"Rice,broken\n')
    } catch (error) {
      expect(error).toBeInstanceOf(CsvParseError)
      expect((error as CsvParseError).line).toBe(3)
    }
  })

  it('returns an empty document for empty input', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] })
  })

  it('handles a header with no data rows', () => {
    expect(parseCsv('Name,Price\n')).toEqual({ header: ['Name', 'Price'], rows: [] })
  })

  it('reads Devanagari content unchanged', () => {
    const doc = parseCsv('नाम,दाम\nचीनी,44\n')
    expect(doc.header).toEqual(['नाम', 'दाम'])
    expect(doc.rows[0]?.cells).toEqual(['चीनी', '44'])
  })
})

describe('detectColumnMapping', () => {
  it('maps a conventional English header', () => {
    const mapping = detectColumnMapping(['Name', 'Unit', 'Price', 'Stock'])
    expect(mapping).toEqual({ nameEn: 0, unitCode: 1, sellingPrice: 2, openingStock: 3 })
  })

  it('ignores case, spaces, underscores and punctuation', () => {
    expect(detectColumnMapping(['Product_Name', 'SELLING PRICE'])).toEqual({
      nameEn: 0,
      sellingPrice: 1,
    })
  })

  it('strips a parenthesised unit from the header', () => {
    expect(detectColumnMapping(['Price (₹)'])).toEqual({ sellingPrice: 0 })
  })

  it('maps a Hindi header', () => {
    expect(detectColumnMapping(['नाम', 'इकाई', 'दाम', 'स्टॉक'])).toEqual({
      nameHi: 0,
      unitCode: 1,
      sellingPrice: 2,
      openingStock: 3,
    })
  })

  it('never claims one column for two fields', () => {
    const mapping = detectColumnMapping(['Name', 'Price', 'Cost Price'])
    expect(mapping.sellingPrice).toBe(1)
    expect(mapping.purchasePrice).toBe(2)
  })

  it('leaves an unrecognised column unmapped rather than guessing', () => {
    // An unmapped column is one dropdown for the shopkeeper to fix. A wrong guess that maps cost
    // to selling price reprices the catalogue silently, and they have no reason to look.
    const mapping = detectColumnMapping(['Name', 'Godown Rack', 'Price'])
    expect(Object.values(mapping)).not.toContain(1)
  })

  it('ignores empty header cells', () => {
    expect(detectColumnMapping(['Name', '', 'Price'])).toEqual({ nameEn: 0, sellingPrice: 2 })
  })

  it('returns an empty mapping for a header it understands nothing of', () => {
    expect(detectColumnMapping(['xyz', 'abc'])).toEqual({})
  })

  it('every template column is auto-detectable from its own name', () => {
    // Guards the round trip: a shopkeeper who downloads our template and uploads it unchanged
    // must reach step 3 with nothing to map by hand.
    for (const column of TEMPLATE_COLUMNS) {
      const mapping = detectColumnMapping([column])
      expect(mapping[column], `template column ${column} is not self-detectable`).toBe(0)
    }
  })

  it('covers every declared import column in the template', () => {
    expect([...TEMPLATE_COLUMNS].sort()).toEqual([...IMPORT_COLUMN_KEYS].sort())
  })
})

describe('toCsv', () => {
  it('quotes only the values that need it', () => {
    expect(toCsvValue('Sugar')).toBe('Sugar')
    expect(toCsvValue('Sugar, loose')).toBe('"Sugar, loose"')
    expect(toCsvValue('say "hi"')).toBe('"say ""hi"""')
    expect(toCsvValue('two\nlines')).toBe('"two\nlines"')
    expect(toCsvValue('carriage\rreturn')).toBe('"carriage\rreturn"')
  })

  it('writes CRLF so Excel on Windows opens the download cleanly', () => {
    expect(toCsv(['A', 'B'], [['1', '2']])).toBe('A,B\r\n1,2\r\n')
  })

  it('round-trips through the parser', () => {
    const text = toCsv(['Name', 'Note'], [['Sugar, loose', 'say "hi"'], ['चीनी', 'two\nlines']])
    const doc = parseCsv(text)

    expect(doc.header).toEqual(['Name', 'Note'])
    expect(doc.rows.map((r) => r.cells)).toEqual([
      ['Sugar, loose', 'say "hi"'],
      ['चीनी', 'two\nlines'],
    ])
  })

  it('writes a header-only file when there are no rows', () => {
    expect(toCsv(['A'], [])).toBe('A\r\n')
  })
})
