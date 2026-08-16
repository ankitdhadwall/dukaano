import { describe, expect, it } from 'vitest'
import type { ColumnMapping, CsvRow } from './csv'
import { findInFileDuplicates, normalizeRow, resolveUnitCode, splitAliases } from './rows'
import type { NormalizedRow } from './rows'

const MAPPING: ColumnMapping = {
  nameEn: 0,
  nameHi: 1,
  unitCode: 2,
  sellingPrice: 3,
  purchasePrice: 4,
  mrp: 5,
  openingStock: 6,
  lowStockThreshold: 7,
  sku: 8,
  shortCode: 9,
  category: 10,
  aliases: 11,
}

/** A well-formed row: Sugar Loose, kg, ₹44.50 selling, ₹40 cost, 25 kg opening. */
const row = (overrides: Partial<Record<number, string>> = {}, line = 2): CsvRow => {
  const cells = [
    'Sugar Loose', 'चीनी खुली', 'kg', '44.50', '40', '', '25', '5',
    'SUG01', 'S1', 'Staples', 'chini|cheeni',
  ]
  for (const [index, value] of Object.entries(overrides)) cells[Number(index)] = value
  return { line, cells }
}

const ok = (result: NormalizedRow) => {
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`)
  return result
}

const failed = (result: NormalizedRow) => {
  if (result.ok) throw new Error('expected the row to fail')
  return result
}

describe('normalizeRow — the happy path', () => {
  it('converts a complete row into integer paise and milli-units', () => {
    const result = ok(normalizeRow(row(), MAPPING))

    expect(result.draft).toEqual({
      nameEn: 'Sugar Loose',
      nameHi: 'चीनी खुली',
      unitCode: 'KG',
      sellingPricePaise: 4450,
      purchasePricePaise: 4000,
      openingStockMilli: 25_000,
      lowStockThresholdMilli: 5_000,
      sku: 'SUG01',
      shortCode: 'S1',
      categoryName: 'Staples',
      aliases: ['chini', 'cheeni'],
    })
    expect(result.line).toBe(2)
  })

  it('accepts a row with only a Hindi name', () => {
    expect(ok(normalizeRow(row({ 0: '' }), MAPPING)).draft.nameHi).toBe('चीनी खुली')
  })

  it('accepts a row with only an English name', () => {
    expect(ok(normalizeRow(row({ 1: '' }), MAPPING)).draft.nameEn).toBe('Sugar Loose')
  })

  it('omits optional fields entirely rather than setting them to empty strings', () => {
    const result = ok(normalizeRow(row({ 4: '', 5: '', 6: '', 7: '', 8: '', 9: '', 10: '', 11: '' }), MAPPING))

    expect(result.draft).toEqual({
      nameEn: 'Sugar Loose',
      nameHi: 'चीनी खुली',
      unitCode: 'KG',
      sellingPricePaise: 4450,
    })
  })

  it('reads prices a shopkeeper actually types', () => {
    expect(ok(normalizeRow(row({ 3: '₹1,25,000.50' }), MAPPING)).draft.sellingPricePaise).toBe(12_500_050)
    expect(ok(normalizeRow(row({ 3: ' 44 ' }), MAPPING)).draft.sellingPricePaise).toBe(4400)
  })

  it('handles a mapping that omits columns the file does not have', () => {
    const result = ok(
      normalizeRow({ line: 2, cells: ['Salt', 'KG', '20'] }, { nameEn: 0, unitCode: 1, sellingPrice: 2 }),
    )
    expect(result.draft).toEqual({ nameEn: 'Salt', unitCode: 'KG', sellingPricePaise: 2000 })
  })

  it('treats cells missing from a short row as blank', () => {
    // The parser deliberately does not pad a misaligned row, so a row that ran out of cells
    // reaches here shorter than the mapping. Those columns read as empty, which produces a
    // pointed "price is required" rather than a crash on an undefined cell.
    const short: CsvRow = { line: 2, cells: ['Salt', '', 'KG'] }
    const result = failed(normalizeRow(short, MAPPING))
    expect(result.errors.map((e) => e.column)).toEqual(['sellingPrice'])
  })

  it('truncates over-long text rather than rejecting the row', () => {
    // A 200-character product name is a paste accident, not a reason to refuse the import.
    const result = ok(normalizeRow(row({ 0: 'x'.repeat(200) }), MAPPING))
    expect(result.draft.nameEn).toHaveLength(120)
  })
})

describe('normalizeRow — errors', () => {
  it('rejects a row with no name in either language', () => {
    const result = failed(normalizeRow(row({ 0: '', 1: '' }), MAPPING))
    expect(result.errors).toContainEqual({ column: 'nameEn', messageKey: 'errors.product.nameRequired' })
  })

  it('rejects a missing selling price', () => {
    const result = failed(normalizeRow(row({ 3: '' }), MAPPING))
    expect(result.errors[0]?.messageKey).toBe('errors.import.priceRequired')
  })

  it('rejects an unparseable price and names the column', () => {
    const result = failed(normalizeRow(row({ 3: 'forty four' }), MAPPING))
    expect(result.errors[0]).toMatchObject({ column: 'sellingPrice', messageKey: 'errors.money.invalid' })
  })

  it('rejects a price with more than two decimals', () => {
    expect(failed(normalizeRow(row({ 3: '44.555' }), MAPPING)).errors[0]?.messageKey).toBe(
      'errors.money.tooManyDecimals',
    )
  })

  it('rejects a negative price', () => {
    expect(failed(normalizeRow(row({ 3: '-10' }), MAPPING)).errors[0]?.column).toBe('sellingPrice')
  })

  it('rejects an unrecognised unit and echoes what was written', () => {
    const result = failed(normalizeRow(row({ 2: 'quintal' }), MAPPING))
    expect(result.errors[0]).toEqual({
      column: 'unitCode',
      messageKey: 'errors.product.invalidUnit',
      params: { unit: 'quintal' },
    })
  })

  it('rejects fractional quantity for a whole-number unit', () => {
    // 1.5 pieces is not a thing. Truncating silently would lose the shopkeeper half a unit.
    const result = failed(normalizeRow(row({ 2: 'piece', 6: '1.5' }), MAPPING))
    expect(result.errors[0]).toMatchObject({
      column: 'openingStock',
      messageKey: 'errors.quantity.tooManyDecimals',
    })
  })

  it('accepts fractional quantity for a unit that permits it', () => {
    expect(ok(normalizeRow(row({ 2: 'kg', 6: '1.5' }), MAPPING)).draft.openingStockMilli).toBe(1500)
  })

  it('reports every bad field at once, not just the first', () => {
    // The shopkeeper fixes the file in one pass rather than re-uploading four times.
    const result = failed(normalizeRow(row({ 0: '', 1: '', 3: 'abc', 4: 'xyz' }), MAPPING))
    expect(result.errors.map((e) => e.column)).toEqual([
      'nameEn',
      'sellingPrice',
      'purchasePrice',
    ])
  })

  it('returns the raw cells with a failed row so it can be written back out', () => {
    const result = failed(normalizeRow(row({ 3: 'abc' }), MAPPING))
    expect(result.cells[0]).toBe('Sugar Loose')
    expect(result.line).toBe(2)
  })

  it('does not report a quantity error when the unit itself is unresolved', () => {
    // Precision depends on the unit, so "invalid quantity" here would be a second, phantom
    // problem sending the shopkeeper to a cell that is fine.
    const result = failed(normalizeRow(row({ 2: 'nonsense', 6: '1.5' }), MAPPING))
    expect(result.errors.map((e) => e.column)).toEqual(['unitCode'])
  })

  it('rejects a blank unit when no default was chosen', () => {
    const result = failed(normalizeRow(row({ 2: '' }), MAPPING))
    expect(result.errors[0]?.messageKey).toBe('errors.import.unitRequired')
  })

  it('uses the chosen default unit for a blank unit cell', () => {
    const result = ok(normalizeRow(row({ 2: '' }), MAPPING, { defaultUnitCode: 'PIECE' }))
    expect(result.draft.unitCode).toBe('PIECE')
  })

  it('an explicit unit still wins over the default', () => {
    const result = ok(normalizeRow(row(), MAPPING, { defaultUnitCode: 'PIECE' }))
    expect(result.draft.unitCode).toBe('KG')
  })

  it('rejects a bad low-stock threshold', () => {
    expect(failed(normalizeRow(row({ 7: 'lots' }), MAPPING)).errors[0]?.column).toBe('lowStockThreshold')
  })

  it('rejects a bad MRP', () => {
    expect(failed(normalizeRow(row({ 5: '??' }), MAPPING)).errors[0]?.column).toBe('mrp')
  })
})

describe('normalizeRow — warnings', () => {
  it('warns, but imports, when the selling price is below cost', () => {
    // Clearing old stock at a loss is a real thing shopkeepers do. Blocking it would be wrong.
    const result = ok(normalizeRow(row({ 3: '30', 4: '40' }), MAPPING))
    expect(result.warnings).toContainEqual({
      column: 'sellingPrice',
      messageKey: 'warnings.import.sellingBelowCost',
    })
  })

  it('warns when the selling price exceeds MRP', () => {
    const result = ok(normalizeRow(row({ 3: '50', 5: '45' }), MAPPING))
    expect(result.warnings.map((w) => w.messageKey)).toContain('warnings.import.sellingAboveMrp')
  })

  it('warns when opening stock arrives with no cost basis', () => {
    const result = ok(normalizeRow(row({ 4: '', 6: '25' }), MAPPING))
    expect(result.warnings.map((w) => w.messageKey)).toContain('warnings.import.stockWithoutCost')
  })

  it('does not warn about a cost basis when there is no opening stock', () => {
    const result = ok(normalizeRow(row({ 4: '', 6: '0' }), MAPPING))
    expect(result.warnings).toHaveLength(0)
  })

  it('a clean row carries no warnings', () => {
    expect(ok(normalizeRow(row({ 5: '50' }), MAPPING)).warnings).toEqual([])
  })
})

describe('resolveUnitCode', () => {
  it.each([
    ['kg', 'KG'], ['KG', 'KG'], ['Kgs', 'KG'], ['kilo', 'KG'], ['किलो', 'KG'],
    ['pc', 'PIECE'], ['pcs.', 'PIECE'], ['Nos', 'PIECE'], ['नग', 'PIECE'],
    ['ltr', 'LITRE'], ['लीटर', 'LITRE'], ['gm', 'GRAM'], ['ग्राम', 'GRAM'],
    ['pkt', 'PACKET'], ['पैकेट', 'PACKET'], ['dozen', 'DOZEN'], ['दर्जन', 'DOZEN'],
    ['box', 'BOX'], ['bottle', 'BOTTLE'], ['bag', 'BAG'], ['ml', 'ML'], ['mtr', 'METRE'],
  ])('resolves %s to %s', (input, expected) => {
    expect(resolveUnitCode(input)).toBe(expected)
  })

  it('returns undefined for a blank or unknown unit rather than guessing', () => {
    expect(resolveUnitCode('')).toBeUndefined()
    expect(resolveUnitCode('   ')).toBeUndefined()
    expect(resolveUnitCode('quintal')).toBeUndefined()
  })
})

describe('splitAliases', () => {
  it('accepts pipe, semicolon and comma separators', () => {
    expect(splitAliases('chini|cheeni;shakkar,चीनी')).toEqual(['chini', 'cheeni', 'shakkar', 'चीनी'])
  })

  it('lowercases, trims and de-duplicates', () => {
    expect(splitAliases(' Chini | chini |CHINI ')).toEqual(['chini'])
  })

  it('drops empty fragments and over-long entries', () => {
    expect(splitAliases('a||  |b')).toEqual(['a', 'b'])
    expect(splitAliases('x'.repeat(61))).toEqual([])
  })

  it('caps the list at twenty', () => {
    expect(splitAliases(Array.from({ length: 30 }, (_, i) => `a${i}`).join('|'))).toHaveLength(20)
  })

  it('returns an empty list for an empty cell', () => {
    expect(splitAliases('')).toEqual([])
  })
})

describe('findInFileDuplicates', () => {
  const withSku = (line: number, sku: string): NormalizedRow => ({
    ok: true,
    line,
    draft: { unitCode: 'KG', sellingPricePaise: 100, sku },
    warnings: [],
  })

  it('flags both rows of a colliding pair, not one arbitrary victim', () => {
    const found = findInFileDuplicates([withSku(2, 'SUG01'), withSku(7, 'SUG01')])
    expect(found).toEqual([{ field: 'sku', value: 'sug01', lines: [2, 7] }])
  })

  it('matches case-insensitively', () => {
    expect(findInFileDuplicates([withSku(2, 'sug01'), withSku(3, 'SUG01')])[0]?.lines).toEqual([2, 3])
  })

  it('finds short-code collisions too', () => {
    const rows: NormalizedRow[] = [
      { ok: true, line: 2, draft: { unitCode: 'KG', sellingPricePaise: 1, shortCode: 'S1' }, warnings: [] },
      { ok: true, line: 3, draft: { unitCode: 'KG', sellingPricePaise: 1, shortCode: 's1' }, warnings: [] },
    ]
    expect(findInFileDuplicates(rows)).toEqual([{ field: 'shortCode', value: 's1', lines: [2, 3] }])
  })

  it('ignores rows with no code and rows that already failed', () => {
    const rows: NormalizedRow[] = [
      { ok: true, line: 2, draft: { unitCode: 'KG', sellingPricePaise: 1 }, warnings: [] },
      { ok: true, line: 3, draft: { unitCode: 'KG', sellingPricePaise: 1 }, warnings: [] },
      { ok: false, line: 4, errors: [], cells: [] },
    ]
    expect(findInFileDuplicates(rows)).toEqual([])
  })

  it('returns nothing when every code is unique', () => {
    expect(findInFileDuplicates([withSku(2, 'A'), withSku(3, 'B')])).toEqual([])
  })
})
