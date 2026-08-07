# `packages/price-guard/`

Margin-floor / MRP price controls — **M05-FR-02**. Never sell **above MRP** or silently
**below the margin floor / cost**.

- **`src/price-guard.ts`** — `checkPrice(input)` returns a verdict and whether the price may
  be published:
  - **`above_mrp`** → **rejected outright** — no approval can authorise it (MRP is a legal
    ceiling).
  - **`below_cost`** → a loss-making price: **blocked pending approval** with a reason
    (P-03 / P-08), by someone other than the setter (§28).
  - **`below_floor`** → below the minimum gross margin (`marginFloorBps`): **blocked pending
    approval**, same rule.
  - **`ok`** → at/above the floor and at/below MRP: allowed.
  - A below-floor / below-cost price becomes `allowed` only when a valid `DecidedRequest`
    (approved, for this price id, decided by a **different** person) is supplied.
  - The margin check is **exact** (BigInt, no float) and pure, so it runs identically on the
    offline edge from cached cost/rules (M05-FR-02 offline rule).

> Composes the `Money` primitive and `packages/approvals` (the approval is produced upstream).
> Tested in `tests/unit/price-guard.test.ts`. Part of the repository layout in `CLAUDE.md`.
