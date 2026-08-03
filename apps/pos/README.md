# `apps/pos/`

The **POS app shell** — the cashier till (desktop / PWA). The most-used surface in the system,
and the home of **hard rule #1**: a core sale never depends on a network call.

Built to the Stage 3 spec in `docs/design/screens/pos-cashier.md`.

## Two parts

- **`src/session.ts` — the model (tested).** `PosSession` is the Sale screen's application
  shell: it holds the basket and composes the tested engines — **line/bill pricing**
  (`packages/pricing`), the **promotions best-price engine** (`packages/promotions`), **tender
  settlement** (`packages/tender`) and the **local sale commit** (`packages/sale`).
  **Synchronous by construction**: scanning, pricing, tendering and committing never await I/O,
  so a sale completes with the cable out and is queued to the outbox for sync afterwards.
  - `scan` (1 interaction) · `setQuantity` / `voidLine` (≤3) · `totals()` (the running total) ·
    `goToTender` (1) · `previewSettlement` · `commit` · `suspend`/`recall` · `newSale`.
  - A **voided line is marked and kept on the bill, never erased** — voids stay visible to loss
    prevention (M15-FR-01), and a void needs a reason.
  - A **pending card/UPI tender is shown honestly** and never counts as paid (M12-FR-03).
  - `syncBadge()` reports connection + **unsent count**, so lag is always visible (§27.1 / P-08).
  - A second tap on Tender is refused with a clear state error — it can never double-bill.
- **`web/` — the shell (PWA).** Framework-free per the §19 baseline ("POS desktop/PWA shell"):
  `index.html` lays out the spec's Sale screen (the **running total is the largest element**, a
  scrolling line list, one dominant **Tender** action, a permanent sync badge); `sw.js`
  pre-caches the shell so the lane **opens and bills during an outage**; `app.js` is the view
  layer only — it renders state and dispatches intents, holding **no** pricing or tender rules.

## Build

```
pnpm build:pos            # bundle the tested model into web/pos-session.bundle.js
pnpm build:pos --watch    # rebuild on change while designing the screen
```

The bundle (esbuild, ESM, ~25 KB) compiles `src/browser-entry.ts` — which wires a real
`PosSession` for the lane and attaches **`src/view-adapter.ts`** as `window.posSession`.
`index.html` loads the bundle **before** `app.js`, so the screen is driven by the **real
engines**. The artifact is git-ignored; if it hasn't been built, `app.js` falls back to its
stand-in and the shell still opens.

- **`src/view-adapter.ts`** — the tested bridge: the view deals only in **display primitives**
  (integer minor units, plain strings), so it can hold **no** business rules. `scan` ·
  `setQuantity` · `voidLine` · `basket` · `payableMinor` · `syncBadge` · `tenderCash` ·
  `newSale`.

## Status

**End-to-end working.** The model and adapter are complete and tested (19 tests, covering the
spec's acceptance: tax-exact totals, weighed goods, promotion discount, honest pending card,
commit-with-cable-out + unsent count, suspend/recall, no double-bill). The built bundle is
verified to drive the real engines: scanning two lines totals ₹295.00 (with 18% tax), a void
stays on the bill and drops the total to ₹236.00, and cash tender commits stock to the lane's
ledger and leaves **unsent = 1** queued for sync. No network call exists anywhere in the sale
path (enforced by `tests/guardrails/pos-offline`).

Remaining for the store: serving the `web/` folder on the lane device, real product lookup
(barcode → price, from the local catalogue cache), and receipt printing.

Tested in `tests/unit/pos-session.test.ts` and `tests/unit/pos-view-adapter.test.ts`. Part of
the repository layout in `CLAUDE.md`.
