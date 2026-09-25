# `packages/reporting/`

Owner command centre KPIs — **M29-FR-01** / D13. The numbers that matter, computed
consistently, always with **how current they are**.

- **`src/sales-summary.ts`** — `salesSummary(sales, currency?)`: aggregates committed sale
  facts into the core KPIs — **gross / net / tax / COGS / margin** (exact integer minor-unit
  sums, never a float), **margin %** (basis points), **basket count / units / average basket**,
  and the **tender mix**. Governed definitions so a figure means the same everywhere (§8.3);
  refuses to blend currencies (`MixedCurrencyError`). Each fact ties back to its immutable source
  for drill-through (M29-FR-02).
- **`src/freshness.ts`** — `freshness(lastSyncedAt, asOf, staleAfterSeconds)`: turns a last-synced
  timestamp into an honest `fresh` / `stale` / `missing` state. Offline or lagging data is shown
  as **stale/missing, never as fresh** (§31 / P-08).
- **`src/consolidation.ts`** — **company-wide roll-ups + drill-down** (M01 / M29 / D13, owner
  decision). The layer above the single-scope KPI: it takes every branch's numbers and rolls them
  **up the organisation** across all the report families (sales, returns, margin, stock/wastage,
  purchases/payables, cash reconciliation, tax, workforce, delivery, exceptions), with the traps
  that make a consolidated report quietly wrong designed out.
  - `ingestContribution(store, c)` — **idempotent** on `(branch, period, family)`: a re-send at the
    same `revision` is IGNORED (never doubles the total), a higher revision REPLACES (late/corrected
    data), a lower one is REFUSED (an out-of-order arrival never overwrites newer data — hard rule #10).
  - `resolveHierarchyAsOf(memberships, asOf)` / `branchesUnder(node, map)` — the **effective-dated**
    structure in force AT the period, never today's applied to old numbers (a branch that opened
    mid-year is not in an earlier month; one that moved companies is attributed to the right one).
  - `consolidate({ nodeId, family, period, contributions, memberships, scope, asOf, staleAfterSeconds })`
    — sums exact-integer measures across the branches that reported; carries the **worst freshness**
    and **names the missing / stale** branches (a total that looks complete while a branch is offline
    is the most dangerous number on the screen); **reconciles** the node to its children; **enforces
    scope** (§28 — a branch manager's total is recomputed to their branch, with what was withheld
    named); and returns a worst-first `contributors` list for the drill-down.

> Pure and deterministic (the caller supplies `asOf`; no clock). Composes the `Money` currency
> type, `freshness`, and (for the transaction-level drill) `@sre/owner-control`. Tested in
> `tests/unit/reporting.test.ts` and `tests/unit/reporting-consolidation.test.ts` (15). Part of the
> repository layout in `CLAUDE.md`.
