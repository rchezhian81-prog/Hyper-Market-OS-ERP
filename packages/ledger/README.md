# `packages/ledger/`

The append-only ledger engine — **hard rule #2** (ledgers are append-only; balances are
**projected** from events, never overwritten) and **§31.1** (idempotent replay; corrections
are compensating entries).

- **`src/ledger.ts`** — `Ledger` (idempotent `append`, `project` a balance from the events,
  `entries`), the `LedgerStore` interface (**append-only by construction** — no change/remove
  operation exists), and `InMemoryLedgerStore` (for tests and the store-edge cache). A
  database-backed store slots in with the persistence layer. Tested in
  `tests/unit/ledger.test.ts`.

> Used by inventory (M08), finance journals (M23) and audit (M34). The append-only rule is
> also enforced in CI by `tests/guardrails/ledger-append-only.test.ts`. Part of the
> repository layout in `CLAUDE.md`.
