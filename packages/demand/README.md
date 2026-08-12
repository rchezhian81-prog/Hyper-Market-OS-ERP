# `packages/demand/`

Demand history from the store's own sales (**M09**) — the input every reorder decision needs,
and the foundation the forecast (**D-1**) and the expiry-markdown ladder (**D-4**) will build on.

- **`src/sales-history.ts`**
  - `salesHistory({ lines, from, to })` — folds the sold lines the caller gathered over a window
    into **per-product demand**: total quantity, the day-by-day series, distinct selling days, and
    an **average daily demand** (`avgDailyDemandMinor`). The average is Σ quantity ÷ **window days**
    (not selling days), so a day with no sale counts as zero demand — which is what "how much will
    sell in the next N days" means, and exactly the `avgDailyDemand` the replenishment / shelf-life
    engine (D-3) consumes. `totalQtyMinor` and `windowDays` are both reported, so a per-selling-day
    figure can be recomputed.
  - A line whose `tradingDay` falls outside `[from, to]` is not counted (the caller may over-read the
    event window and let this be exact); a malformed day or a non-positive quantity is skipped, not
    fatal. `InvalidDemandWindowError` for a malformed window or `from` after `to`.

> **Not a write path.** The store already keeps every sale as an append-only `SaleCommitted` event
> (the events ARE the record — hard rule #2). This turns those banked lines into a demand read; it
> stores nothing and never touches the sale-commit path (hard rule #1). Pure and deterministic — no
> clock, no I/O — so it runs the same on the store edge or in the cloud. Tested in
> `tests/unit/demand-sales-history.test.ts`. Part of the repository layout in `CLAUDE.md`.
