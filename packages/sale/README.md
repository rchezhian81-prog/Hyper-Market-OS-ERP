# `packages/sale/`

The local POS sale commit — **hard rule #1** (a core sale never depends on the network:
commit locally first, then sync idempotently) and **M12** (POS sales & checkout). This is
the integration brick: it composes the foundation into one real transaction.

- **`src/sale.ts`** — `commitSale(input, stockLedger, outbox)`: checks the sale is fully
  paid (tender settlement — no fake approval), appends stock movements to the local
  **append-only stock ledger**, enqueues the sale to the **sync outbox**, and returns the
  `CommittedSale` (with any change due) — all with **no network call**. Idempotent on the
  sale id, so a retried commit collapses to one effect (§31.1); an unpaid sale throws
  `UnpaidSaleError`. Tested in `tests/unit/sale.test.ts`.

> Composes `packages/tender`, `packages/ledger`, `packages/sync` and the `DomainEvent`
> envelope. The `pos-offline` guardrail covers hard rule #1 at the code level; this engine
> is the domain flow. Part of the repository layout in `CLAUDE.md`.
