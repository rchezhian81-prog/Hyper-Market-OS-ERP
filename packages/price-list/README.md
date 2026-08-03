# `packages/price-list/`

Effective-dated price lists — **M05-FR-01**. One price truth (P-02): decide **which** price
applies, when, and to whom.

- **`src/price-list.ts`**
  - `resolvePrice(entries, ctx)` — resolves the winning `PriceEntry` by **precedence**
    (customer > channel > zone > store base). Only **published** (`status: 'active'`) entries
    **within their effective window** at `ctx.at` are candidates, so a **future price never
    activates early**; within a scope, the most recently effective entry wins (ties → version,
    then id) — the explicit precedence for overlapping prices. Returns `null` when no price
    applies. The returned entry carries its **id/version**, so a sale can **lock the version it
    referenced** and not be repriced mid-transaction (§31.1).
  - `priceHistory(entries, productId)` — the full chronological, **append-only** who-changed-
    what history (a change is a new entry, never an overwrite — §29.1).

> This resolver is pure and input-determined, so an offline lane resolves exactly what the
> cloud would. Publishing/approval of price entries (maker-checker) happen upstream. Composes
> the `Money` primitive. Tested in `tests/unit/price-list.test.ts`. Part of the repository
> layout in `CLAUDE.md`.
