# Database-test verification — closing the migration-tests-never-ran-in-CI gap

**Control:** hard rules #2, #6, #7, #9; P-08; QG-08 (recovery) neighbourhood; MG-04
(additive, reversible, versioned migrations). The standing rule is *additive migrations only,
proven against a real database.*

**Baseline audited:** commit `12d84937457765acff7bc33a6c47499d0dc52f8e`.

**Executed:** 11 September 2026 against a **disposable, isolated PostgreSQL 16.13** cluster
(`initdb` under the `postgres` OS user, `trust` auth, loopback-only on port 55432, synthetic /
empty data — **never production**, hard rule #7). Torn down after the run.

---

## The gap this closes

At the audited commit the local suite reported **6,292 passed; 262 skipped** — the 262 skipped
only because `DATABASE_URL` was absent. In the CI PostgreSQL job those DB-backed tests ran, **but
only `tests/integration`**: the job's test step was `pnpm run test:integration`, which is
`vitest run tests/integration`. The **six real-database tests in
`tests/migration/schema-migrations.test.ts`** (the `describe.skipIf(!DATABASE_URL)` block) were
therefore **never once run against a database in CI**:

- In the `verify` job, `pnpm test` includes them but has no `DATABASE_URL`, so they skip.
- In the `integration` job, `DATABASE_URL` is set but the step targeted only `tests/integration`.

256 integration DB tests + 6 migration DB tests = the 262 skipped locally. The 6 were the blind
spot. **Step 1 answer: the code at the baseline did *not* resolve this — the gap was real.**

## The real failure this exposed (found, not assumed)

Run in isolation against a pristine database, one of the six failed:

> `tests/migration/schema-migrations.test.ts` › *"refuses an UPDATE and a DELETE on the ledger,
> by name (hard rule #2)"* — the `UPDATE event_ledger …` returned `command: UPDATE, rowCount: 0`
> instead of raising.

**Root cause:** the append-only guard is a `FOR EACH ROW` trigger (migration `0004`). Against an
**empty** `event_ledger` an `UPDATE`/`DELETE` matches no row, so the trigger never fires and the
statement "succeeds" affecting zero rows. The test had no data of its own; it only ever passed by
relying on rows another suite had left in the shared CI database — and since it never ran in CI at
all, that reliance was invisible. On an empty table it proved **nothing**.

**Fix (strengthening, no assertion weakened):** the test now appends one synthetic ledger row
(INSERT/append is permitted — only UPDATE/DELETE are guarded), asserts the append landed, then
proves the guard refuses editing *and* deleting that real row. The guard itself was correct; the
**test** was not actually exercising it. `tests/migration/schema-migrations.test.ts`.

## What was run, and the exact results

Disposable DB: `DATABASE_URL=postgres://sre@127.0.0.1:55432/sre_core`.

| Command | Result |
|---|---|
| `pnpm db:migrate` (first) | **11 applied** (0001–0011) |
| `pnpm db:migrate` (second) | **0 applied, 11 skipped** — idempotent re-apply |
| `vitest run tests/migration/schema-migrations.test.ts` (pristine DB) | **16 passed, 0 failed, 0 skipped** (10 static-scan + **6 real-database**) |
| `DB_TESTS_REQUIRED=1 pnpm run test:db` (integration + migration, pristine DB) | **219 files, 1,465 passed, 0 failed, 0 skipped** |
| `pnpm test` (full suite) **with** `DATABASE_URL`, pristine DB | **581 files, 6,554 passed, 0 failed, 0 skipped** — the 262 formerly-skipped now execute (6,292 + 262 = 6,554) |
| `pnpm test` (full suite) **without** `DATABASE_URL` (the `verify` job) | **6,293 passed, 262 skipped** — the DB-gated tests skip as designed off-database (+1 vs baseline = the new fail-loud guard test) |
| `pnpm run typecheck` · `pnpm run lint` · `pnpm run secret-scan` | all clean (secret scan: 1,570 files) |

Honest note: the **262 skipped** in the last row are skipped, **not passed** — they run only where a
database is present. The row above it is where they run and pass.

## The migration guarantees, verified in the database (step 5)

The six real-database tests, all executed and passing against the disposable PostgreSQL:

1. **Applies, then re-applies changing nothing** — idempotent (the interrupted-deploy case).
2. **Records exactly one row per migration**, however many times it runs.
3. **The append-only guards are actually installed** — triggers present on `event_ledger`.
4. **`UPDATE` and `DELETE` on the ledger are refused by name** (hard rule #2) — now proven on a real
   seeded row, not vacuously on an empty table.
5. **Tenant-scoped uniqueness holds** (§31.1 / ADR-0003) — a replay is one effect, per tenant.
6. **A new migration applies additively** — recorded once, previous rows and their `applied_at`
   stamps untouched.

## The CI change (step 4)

`.github/workflows/ci.yml`, the `integration` (real-PostgreSQL) job:

- Its test step now runs **`pnpm run test:db`** = `vitest run tests/integration tests/migration`,
  so the migration suite runs against the real database on every push, not only the integration
  suite. New scripts: `test:migration`, `test:db`.
- The job sets **`DB_TESTS_REQUIRED=1`**, and a new guard
  (`tests/migration/db-required-in-ci.test.ts`) **fails the job** if `DATABASE_URL` is unset or the
  database does not answer — so a required DB run can never pass green having silently skipped
  everything (P-08). A shell `test -n "$DATABASE_URL"` check is the belt to that brace.

**Fail-loud proven, three ways:** flag unset + no DB → guard passes (local skip allowed);
required + DB present → passes; **required + DB missing → the job FAILS by name.**

## Verdict

**Database-test verification gap: CLOSED.** All database-dependent tests, **including the six
migration tests**, were run against an isolated disposable PostgreSQL 16.13 and pass. One real
defect (an append-only test that proved nothing on an empty table) was found and fixed by
strengthening the test. Migrations apply, re-apply safely, preserve existing records, keep the
ledger's append-only protections, and accept an additive migration — each verified in the database.
CI now runs the migration suite in the required job and fails loudly, never silently, if the
database is missing. Nothing was merged or deployed by this work.

## What the owner should check

1. **On the next pull request, open the CI run and find the "real PostgreSQL" job.** Its test step
   now says it runs the *stage gate + migration suites*, and the log lists the migration tests
   running — not only the integration ones.
2. **Ask what happens if someone removes the database setting from that job.** The correct answer is
   *"the job fails and says the database is missing"*, not *"the tests quietly skip and it goes
   green"*. There is now a test that enforces exactly that.
