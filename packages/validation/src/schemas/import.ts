import { z } from 'zod'
import { IMPORT_COLUMN_KEYS } from '@dukaano/business-logic'
import { unitCodeSchema } from './catalogue'

/**
 * Bulk product import (blueprint §6 "Import wizard", journey J3).
 *
 * The wire contract is **stateless**: there is no server-side import job. The client holds the
 * file between steps and sends it again on commit, and the server re-parses and re-validates from
 * the original text every time.
 *
 * That is a deliberate trade (see ADR-0006). The alternative — persisting a parsed job and
 * committing by id — is fewer bytes on the wire but introduces a second source of truth that can
 * be stale, tampered with, or committed twice. Re-deriving from the file means the commit is
 * validated against exactly what the shopkeeper uploaded, not against what a previous request
 * claimed about it.
 */

/** The maximum rows one commit will accept. */
export const MAX_IMPORT_ROWS = 5_000

/**
 * The maximum uploaded text length, in characters.
 *
 * Characters rather than bytes, deliberately: this schema also runs in the React Native client,
 * where `Buffer` does not exist. The true byte ceiling is enforced once, at the HTTP body-parser
 * limit in the API — the right layer for it, and the only one an attacker cannot skip. This bound
 * exists to give the shopkeeper a comprehensible error before a 413 does.
 *
 * 5,000 rows of Devanagari with every column filled runs to roughly 900k characters.
 */
export const MAX_IMPORT_CHARS = 3_000_000

const columnMappingShape = Object.fromEntries(
  IMPORT_COLUMN_KEYS.map((key) => [key, z.number().int().min(0).max(200).optional()]),
) as Record<(typeof IMPORT_COLUMN_KEYS)[number], z.ZodOptional<z.ZodNumber>>

/**
 * Which uploaded column feeds which field, by zero-based index.
 *
 * Always supplied by the client on commit, never re-detected server-side. Auto-detection is a
 * convenience the shopkeeper reviews and corrects in step 2; silently re-running it at commit
 * could map a column differently from what they approved on screen.
 */
export const columnMappingSchema = z.object(columnMappingShape).strict()
export type ColumnMappingInput = z.infer<typeof columnMappingSchema>

const importFileSchema = z.object({
  /**
   * The file as text. XLSX is converted to CSV in the browser before upload — see ADR-0006 for
   * why the spreadsheet parser lives on the client and not here.
   */
  content: z
    .string({ required_error: 'errors.import.fileRequired' })
    .min(1, 'errors.import.fileEmpty')
    .max(MAX_IMPORT_CHARS, 'errors.import.fileTooLarge'),
  /** Applied to rows whose unit cell is blank. No default — see NormalizeOptions. */
  defaultUnitCode: unitCodeSchema.optional(),
})

export const importPreviewSchema = importFileSchema.extend({
  /** Omitted on the first preview so the server auto-detects and proposes a mapping. */
  mapping: columnMappingSchema.optional(),
})
export type ImportPreviewInput = z.infer<typeof importPreviewSchema>

/**
 * What to do about a row that clashes with an existing product.
 *
 * `SKIP` is the default for every unresolved duplicate. Overwriting a live product's price
 * because a spreadsheet happened to reuse its SKU is not something to do by default — the
 * shopkeeper must say so per row.
 */
export const duplicateActionSchema = z.enum(['SKIP', 'UPDATE', 'CREATE_ANYWAY'])
export type DuplicateAction = z.infer<typeof duplicateActionSchema>

export const importCommitSchema = importFileSchema.extend({
  mapping: columnMappingSchema,
  /**
   * Per-row resolutions, keyed by the **line number shown in the preview**, which is the line
   * number in the shopkeeper's own spreadsheet. Keying by array position would silently
   * mis-target a row if the file were edited between preview and commit; keying by line means a
   * changed file produces a mismatch that can be detected rather than a wrong product updated.
   */
  decisions: z.record(z.string().regex(/^\d+$/), duplicateActionSchema).optional(),
  /**
   * Rows carrying only warnings import unless this is false. Rows with errors never import.
   */
  acceptWarnings: z.boolean().optional().default(true),
})
export type ImportCommitInput = z.infer<typeof importCommitSchema>
