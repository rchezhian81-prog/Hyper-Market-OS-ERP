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

- **`src/forecast.ts`** (D-1) — a forward-looking demand forecast, decomposed and explainable.
  - `forecastDemand({ history, from, to, horizonDays })` — fits **baseline × day-of-week seasonality**
    on the window and projects `horizonDays` ahead. A hypermarket's steadiest signal is the week, so
    the forecast is a baseline level times a learned per-weekday multiplier — a number a buyer can
    read, not a black box. A day with no history is zero demand (real information), and an empty
    history forecasts zero rather than guessing.
  - `backtestForecast({ history, from, to, holdoutDays })` — fits on the earlier part, forecasts the
    held-out tail, and scores it (**WAPE** = Σ|actual − forecast| ÷ Σ actual, plus MAE), so "the
    forecast is good" is a bounded number, not a claim (the D-1 acceptance). `InvalidForecastInputError`
    for a malformed window/horizon, or a holdout with no training days left.
  - Richer signals the roadmap names — promotions, festivals, weather, new-item cold-start — layer ON
    this baseline and are **follow-on** work, named here so they are deferred openly, not dropped.

- **`src/markdown.ts`** (D-4) — the expiry markdown ladder, the commercial partner to the perishables work.
  - `proposeMarkdown({ …, remainingShelfLifeDays, onHandMinor, avgDailyDemandMinor, currentPriceMinor,
    policy? })` proposes a marked-down price from **two** inputs the roadmap names: **sell-through** decides
    *whether* (projected sales = demand × days left; only the **surplus** that will not clear needs a cut —
    a markdown on stock that would sell anyway is margin given away), and **remaining shelf life** decides
    *how deep* (a ladder that deepens as the use-by nears). The ladder is **data** (`DEFAULT_MARKDOWN_LADDER`:
    10% within a week, 25% within three days, 50% on the last day), so a rule change is a config edit.
  - **Advisory only** — every proposal is `advisoryOnly: true`, and there is **no** function here that
    changes a price: committing goes through the real price-change approval path (hard rule #5), and a test
    reads the module's exports to prove no shortcut exists. `InvalidMarkdownInputError` on bad input/policy.

> **Not a write path.** The store already keeps every sale as an append-only `SaleCommitted` event
> (the events ARE the record — hard rule #2). This turns those banked lines into a demand read; it
> stores nothing and never touches the sale-commit path (hard rule #1). Pure and deterministic — no
> clock, no I/O — so it runs the same on the store edge or in the cloud. Tested in
> `tests/unit/demand-sales-history.test.ts`. Part of the repository layout in `CLAUDE.md`.
