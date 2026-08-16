# ADR-0006 — Bulk import is stateless and two-phase; XLSX is parsed client-side

**Status:** Accepted · **Date:** 2026-08-16 · **Blueprint:** §6 (import wizard), journey J3

## Context

The import wizard is four steps — upload, column mapping, preview with per-row validation and
duplicate resolution, then commit with a downloadable failed-row file. Two questions had to be
answered before any of it could be built, and the blueprint specified neither.

**Where does wizard state live between steps?** The conventional answer is an `import_job` table:
upload creates a job, the parsed rows are persisted, the preview reads them, and the commit
references the job by id.

**Who parses XLSX?** Accepting `.xlsx` means a spreadsheet parser somewhere. Server-side means a
dependency like SheetJS in the API — a large surface that reads untrusted binary files from the
internet, historically a source of prototype-pollution and zip-bomb advisories.

## Decision

**Stateless, two-phase.** There is no import job. The client holds the file between steps and
sends it again on commit; the server re-parses and re-validates from the original text every time.

**XLSX is converted to CSV in the browser.** The API accepts CSV text only. The web app runs the
spreadsheet parser in the tab, where an exploit is confined to a sandboxed origin rather than
running as the process that holds the database credentials.

**One parser, shared.** `parseCsv` and `normalizeRow` live in `@dukaano/business-logic`, which
runs in both the browser and the server. The preview the shopkeeper approves and the commit the
server performs are computed by the same code.

**Validate everything, then write.** Rows with errors are reported and never attempted. Valid rows
are written inside the request's single tenant transaction, so the import is all-or-nothing.

## Consequences

**Good.** The commit is validated against exactly what the shopkeeper uploaded. With a job table,
the commit trusts a row set that some earlier request wrote — which can be stale, can be replayed,
and is one more thing to authorize. Re-deriving from the file removes that whole class.

**Good.** No `import_job` / `import_row` tables, no lifecycle, no cleanup job for abandoned
uploads, no "your import expired" state to design a screen for. The wizard is genuinely
restartable: the shopkeeper's file is the state.

**Good.** All-or-nothing means there is no partial catalogue. The shopkeeper is never left with
3,000 of 5,000 products and no way to tell which — which is a far worse position than a failed
import, because it cannot be safely retried.

**Good.** The 5,000-row commit measures ~850 ms in the integration suite, well inside the
2-minute `@LongTransaction` budget.

**Bad.** The file crosses the wire twice, roughly 900 kB each way for 5,000 rows. On a 3G
connection in Himachal that is a real wait, twice. Accepted because it happens once per import,
and correctness on a catalogue-wide write matters more than one upload's latency.

**Bad.** The JSON body limit had to rise to 4 MB for every route, not just this one, because
Express applies it at the parser. Partly mitigated by `MAX_IMPORT_CHARS` and `MAX_IMPORT_ROWS`
rejecting oversized input with a comprehensible message before the 413.

**Bad.** A file edited between preview and commit produces a commit that does not match what was
reviewed. Mitigated by keying duplicate decisions on **line number** rather than array position,
so an edited file mis-targets visibly rather than silently updating the wrong product. Not fully
solved: a content hash checked at commit would close it, and is the obvious follow-up if this
turns out to happen.

**Bad.** XLSX support now depends on the web client. A future mobile or CLI import path must
either bring its own converter or accept CSV only. Stated in the API contract rather than
discovered.

## Alternatives rejected

**Job table with a background worker.** The right design at a scale Dukaano does not have. It buys
progress reporting and resumability for imports that take minutes; ours takes under a second.

**Per-row commit with error recovery.** Would let 4,988 rows succeed while 12 fail at the database
level. Rejected: the rows that fail at *that* point are the ones validation could not predict —
concurrent writes, constraint violations — and a partial catalogue from an unpredictable cause is
the hardest possible state to explain to a shopkeeper or to recover from.
