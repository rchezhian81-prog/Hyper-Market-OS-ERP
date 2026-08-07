# `packages/counts/`

Cycle / blind physical count reconciliation — **M09-FR-04** (WF-08). The **honest count**:
the counter enters a **blind** physical count, and the system decides the truth against the
ledger.

- **`src/counts.ts`**
  - `reconcileCount(input, stockLedger, outbox)` — derives the **expected** on-hand by
    projecting the stock ledger (the counter never supplies or sees it, so blind-count
    integrity is **structural**), computes and **values** the variance (counted − expected),
    and:
    - if the count matches → returns `reconciled` with nothing written;
    - if it differs → commits a **reason-coded compensating adjustment** (`InventoryAdjusted`)
      toward the counted truth, which requires a **separate approver** when the valued variance
      is material (the counter can never be the sole approver of their own variance, §28).
    Counts are captured offline and reconcile on sync. Idempotent on the count id.
  - `onHandMinor(stockLedger, productId)` — the on-hand quantity, **projected** from the
    ledger (never stored).

> Composes `packages/adjustment` (which enforces the reason + separation-of-duties rules),
> `packages/ledger` and `packages/sync`. A material variance thus flows straight into the
> M08-FR-03 approval path. Tested in `tests/unit/counts.test.ts`. Part of the repository layout
> in `CLAUDE.md`.
