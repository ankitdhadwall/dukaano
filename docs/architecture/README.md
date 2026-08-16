# Architecture Decision Records

The [blueprint](../dukaano-blueprint.md) is the contract. Sections marked **DECISION** are binding,
and changing one requires an ADR here saying what changed and why.

An ADR is written when implementation contradicts the blueprint, or when the blueprint was silent
on something that turned out to be load-bearing. It is not written for choices the blueprint
already made — those live in the blueprint.

| # | Decision | Status | Supersedes |
|---|---|---|---|
| [0001](adr-0001-rounding-half-away-from-zero.md) | Rounding is half **away from zero**, not half-up | Accepted | Blueprint §15.2 |
| [0002](adr-0002-no-force-row-level-security.md) | No `FORCE ROW LEVEL SECURITY`; a boot-time role assertion instead | Accepted | Blueprint §23.3 |
| [0003](adr-0003-vitest-over-jest-testcontainers.md) | Vitest against a long-lived Postgres, not Jest + Testcontainers | Accepted | Blueprint §26 |
| [0004](adr-0004-auth-membership-security-definer.md) | A `SECURITY DEFINER` function for the pre-tenant login lookup | Accepted | — (blueprint silent) |
| [0005](adr-0005-no-restricted-imports-over-boundaries.md) | `no-restricted-imports` rather than `eslint-plugin-boundaries` | Accepted | Blueprint §29 |
| [0006](adr-0006-stateless-two-phase-import.md) | Bulk import is stateless and two-phase; XLSX is parsed client-side | Accepted | — (blueprint silent) |
| [0007](adr-0007-composite-sync-cursor.md) | The sync cursor is a composite `(txid, changeId)`, not an xmin alone | Accepted | Blueprint §14.5 |

## Format

Context (the forces, including the ones that pull the other way) → Decision → Consequences,
**including the ones we dislike**. An ADR that lists only benefits is marketing, and it is useless
to whoever has to revisit the decision in a year.
