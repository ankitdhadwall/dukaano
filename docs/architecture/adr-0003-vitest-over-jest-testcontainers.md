# ADR-0003 — Vitest against a long-lived Postgres, not Jest + Testcontainers

**Status:** Accepted · **Date:** 2026-08-16 · **Refines:** Blueprint §26

## Context

Blueprint §26 names Jest for unit tests and Testcontainers for integration tests.

Two things about this codebase pull against that pairing:

**Jest.** The workspace is ESM TypeScript with `bigint` in the domain model. Jest needs either
`ts-jest` (slow) or Babel (which drops type information and needs its own bigint handling in the
serializer). Every pure package — money, business-logic, i18n, validation, types — is plain
TypeScript with no framework, and Vitest runs those natively with no transform config at all.
The API package needs SWC for decorator metadata, which Vitest supports via `unplugin-swc`.

**Testcontainers.** It gives a clean database per run at the cost of ~15–30 s of container startup
before the first assertion. The tests we care about most are the RLS tests, and those are the ones
we want to run on every save. A 20-second penalty on a suite that takes 6 seconds to execute means
it gets run at the end of the day instead of during the work, which defeats the purpose.

Testcontainers also needs a working Docker socket in CI, which is one more thing that can fail for
reasons unrelated to the code.

## Decision

**Vitest everywhere**, with two projects in the API package: `unit` (no database) and
`integration` (database required).

**A long-lived Postgres 16** from `infra/docker-compose.yml` on port 5433, with a separate
`dukaano_test` database. CI runs the same image as a service container, so local and CI execute
identical SQL against an identical server.

Isolation comes from **per-suite truncation** plus **distinct shop ids per test**, rather than from
a fresh container. Tenant tests create their own shops and assert against them, so cross-test
interference would have to cross a tenant boundary — which is precisely what the tests exist to
prove is impossible. That makes the isolation strategy self-checking: if suites did leak into one
another, the tenant-isolation suite would fail first and loudest.

**The safety rail this needs.** A test suite pointed at the development database will happily
truncate it. `test/harness.ts` therefore asserts `current_database() = 'dukaano_test'` before any
test runs, and `createTestApp()` imports the application module **dynamically** so that
`process.env.DATABASE_URL` is set before `env.ts` reads it. That second point is not incidental:
ES imports hoist, and the integration suite silently ran against the *development* database until
the dynamic import was added. The assertion is what turned a silent wrong-database run into a
failed test.

## Consequences

**Good.** No transform configuration for five of six packages. Watch mode is usable on the
integration suite. Coverage via `@vitest/coverage-v8` is fast enough to gate at 100% on the pure
packages without anyone resenting it.

**Bad.** The database is shared state a developer can corrupt. A half-finished migration or a
manually inserted row can make an unrelated test fail confusingly. `pnpm db:reset` fixes it, but
only once someone works out that's the problem.

**Bad.** Tests are not fully parallel-safe across suites that touch the same shop id. Vitest is
configured with a single fork for the integration project, which costs wall-clock as the suite
grows. If the integration suite passes ~60 s, the answer is a database-per-worker template
(`CREATE DATABASE … TEMPLATE dukaano_test_template`), not Testcontainers — same isolation, ~200 ms
instead of ~20 s.

**Bad.** It departs from the blueprint on a section that was not marked DECISION, which makes this
ADR the only record. Hence writing it.
