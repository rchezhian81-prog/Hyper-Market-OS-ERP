# `packages/cash/`

Till cash movements — **M14-FR-01**. Float issue, loans, pickups and safe drops, each an
**append-only** `CashMovement` event (hard rule #2). This is the cash chain that feeds the
shift close (`packages/till`): its pickups and float are the inputs to expected cash.

- **`src/cash.ts`**
  - `recordCashMovement(input, cashLedger, outbox)` — enforces a positive amount, the
    **one-custodian-per-till** rule (a `float_issue` needs a free till — `TillAlreadyAssignedError`;
    every other kind needs the till held by the named custodian — `TillNotAssignedError`), and
    **no overdraw** (you cannot take out more than the drawer holds —
    `InsufficientTillCashError`). Appends a `CashMovement` to the append-only cash ledger and
    queues it for sync — no network call (fully offline). Idempotent on the movement id.
  - `tillBalanceMinor(cashLedger, tillId)` — the till drawer balance, **projected** from the
    events (never stored — mirror of the ledger rule).
  - `tillCustodian(cashLedger, tillId)` — the current open custodian (a `float_issue` opens a
    custody, a `float_return` closes it), or `null`.

> Kinds: `float_issue` / `loan` add to the drawer; `pickup` / `safe_drop` / `float_return`
> take out of it (to the safe). Composes `packages/ledger`, `packages/sync` and the `Money`
> contract. Tested in `tests/unit/cash.test.ts`. Part of the repository layout in `CLAUDE.md`.
