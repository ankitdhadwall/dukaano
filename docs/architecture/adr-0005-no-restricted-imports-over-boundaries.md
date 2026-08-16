# ADR-0005 — `no-restricted-imports` rather than `eslint-plugin-boundaries`

**Status:** Accepted · **Date:** 2026-08-16 · **Refines:** Blueprint §29

## Context

Blueprint §29 defines a layered package graph and requires it to be mechanically enforced:

```
types ← money ← business-logic ← validation ← { api, web, mobile }
```

with hard rules — the pure packages import no framework code, the API imports no UI package, money
formatting happens only in `@dukaano/i18n`.

`eslint-plugin-boundaries` is the obvious tool. It models element types and an allow-matrix
between them, which is a good fit conceptually. Against it:

- It needs its own settings block describing every package as an "element type", duplicating
  information already present in `pnpm-workspace.yaml` and each `package.json`.
- The `pnpm` workspace protocol (`workspace:*`) already makes an undeclared dependency a
  **resolution failure** — the import does not exist at runtime. The plugin would mostly be
  restating a constraint the package manager enforces harder.
- It is a fourth-party dependency in the lint path of a codebase whose lint config is itself a
  security control (the `parseFloat` and `$queryRawUnsafe` bans).

The rules that `workspace:*` does *not* cover are the ones about **what is imported**, not
**whether the package is a dependency**: NestJS inside a pure package, `Intl.NumberFormat` outside
i18n, a UI package inside the API.

## Decision

Enforce the graph with two layers:

**`workspace:*` dependencies** carry the layering. If `@dukaano/money` does not list
`@dukaano/business-logic`, the import fails to resolve. This is stronger than a lint error, because
it cannot be suppressed with a disable comment.

**`no-restricted-imports` and `no-restricted-syntax`** in `packages/config/eslint/` carry
everything the dependency graph cannot express, each rule naming the blueprint section it enforces:

| Rule | Enforces |
|---|---|
| `@nestjs/*`, `express`, `@prisma/client` banned in `library.mjs` | §29 — pure packages stay framework-free |
| `@dukaano/ui-*` banned in `nest.mjs` | §29 — the API imports no UI |
| `Intl.NumberFormat` banned outside `@dukaano/i18n` | §22.5 — one money formatter |
| `parseFloat` / `.toFixed()` banned outside `@dukaano/money` | §15.1 — money is integer paise |
| `$queryRawUnsafe` / `$executeRawUnsafe` banned | §23.5 — raw SQL only via parameterized templates |
| empty `catch` is an error, not a warning | §54 — never swallow errors |

Messages quote the section, so a developer who hits one is told *why*, not just *no*.

## Consequences

**Good.** No extra dependency, no settings block to drift out of sync with the workspace. The
error a developer sees names the blueprint section, which makes the rule arguable on its merits
rather than a mystery.

**Good.** The half the plugin would have covered is covered by something stricter — an unresolvable
import beats a lint error.

**Bad.** The rules are string patterns, not a graph. Adding a package means remembering to extend
the right config file, and forgetting produces no error — just a package with weaker rules than its
siblings. A boundaries plugin would have inferred it. This is the real cost, and it is paid at
exactly the moment nobody is thinking about lint config.

**Bad.** `no-restricted-syntax` selectors are AST queries, which are harder to read than a
declarative allow-matrix, and a wrong selector fails open — it silently matches nothing. The
mitigation is that each restricted rule has a test asserting it actually fires.

**Bad.** ESLint flat config is last-match-wins, which bit us: `nest.mjs` re-declared
`no-restricted-syntax` and thereby re-enabled it inside test files, where `base.mjs` had
deliberately relaxed it. The relaxation had to be re-applied *after* the block that overrides it.
A plugin with a settings-based model would not have had this failure mode.

## Revisit if

The package count passes roughly a dozen, or a package is added with the wrong rules and it is not
caught in review. At that point the inference a boundaries plugin provides starts to be worth its
configuration.
