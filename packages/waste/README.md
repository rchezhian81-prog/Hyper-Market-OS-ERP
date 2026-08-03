# `packages/waste/`

Waste / write-off — **M28-FR-01**. Record what leaves as loss — **wastage, damage, expiry,
donation, destruction** — safely and honestly.

- **`src/waste.ts`** — `commitWriteOff(input, stockLedger, outbox)`:
  - Requires a **reason code** (`MissingReasonError`) and removes a positive quantity.
  - A **material** loss (value at/above the tenant threshold) needs **captured evidence**
    (photo/witness — `MissingEvidenceError`) **and** an approval by a **different person** (§28,
    enforced by the adjustment engine).
  - Appends **one reason-coded compensating stock movement** (a loss removes stock — never an
    edit, hard rule #2) via `packages/adjustment`, valued for finance (M23).

> A write-off is a special adjustment, so it **reuses** `commitAdjustment` (M08-FR-03) for the
> compensating movement and the separation-of-duties check — the same way `packages/counts`
> reuses it. Pairs with the FEFO **expiry action list** (`packages/fefo`: expired → dispose).
> Composes `packages/adjustment`, `packages/ledger` and `packages/sync`. Tested in
> `tests/unit/waste.test.ts`. Part of the repository layout in `CLAUDE.md`.
