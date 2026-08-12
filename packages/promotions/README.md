# `packages/promotions/`

Promotions best-price engine — **M05-FR-03**. One promotion truth (P-02) that yields a
**deterministic** best price for a basket: the same basket gives the same price online and
offline (M05-FR-03 acceptance).

- **`src/promotions.ts`** — `bestPrice(lines, promotions, ctx)`:
  - Considers only promotions that are **published** (`status: 'active'`) and **in their
    effective window** at `ctx.at`, and whose gates pass (member / coupon). An expired or
    unpublished promotion **never applies** (§31) — this is structural, not UI discipline.
  - Supported kinds (all configurable — "choose-able"): **`percent_off`** (with optional min
    spend), **`amount_off`** (fixed coupon, capped at eligible spend), **`buy_x_get_y`** (BOGO
    / multibuy — the cheapest Y per (X+Y) block are free, with an optional abuse cap
    `maxApplications`), and **`member_price`** (a special per-unit price for members).
  - **Exclusivity is deterministic**: within an `exclusiveGroup` only the single
    best-for-the-customer promotion applies (ties broken by promotion id); everything else
    **stacks**. The total discount is capped at the basket gross (no negative prices).
  - **Per-line attribution** (`result.perLine`): the total discount is split back onto the lines
    it actually reduced — a **targeted** promotion comes off its own eligible lines, a
    **basket-wide** one is spread across all lines in proportion to gross (largest-remainder
    rounding, `@sre/contracts` `allocateDiscount`). The shares sum to `discount` exactly and none
    exceeds its line's gross. This is what lets a sale record each line's **post-discount** total,
    so the GST return files the correct taxable value per HSN (CGST s.15(3)) and the line totals
    add up to what the customer paid.
  - **Pure and input-determined** — no clock, no I/O — so an offline lane computes exactly
    what the cloud would.

> Targeting is by explicit `productIds` and/or a line `group` tag (neither = whole basket).
> This engine computes discounts only; approval/publishing of the rule set happen upstream
> (maker-checker). Composes the `Money` primitive. Tested in `tests/unit/promotions.test.ts`.
> Part of the repository layout in `CLAUDE.md`.
