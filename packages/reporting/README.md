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

> Pure and deterministic (the caller supplies `asOf`; no clock). Composes the `Money` currency
> type. Tested in `tests/unit/reporting.test.ts`. Part of the repository layout in `CLAUDE.md`.
