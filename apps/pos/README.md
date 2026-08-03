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

## Status

The model is complete and tested (13 tests, covering the spec's acceptance: tax-exact totals,
weighed goods, promotion discount, honest pending card, commit-with-cable-out + unsent count,
suspend/recall, and no double-bill). The `web/` shell is a **runnable static scaffold**: it
exercises the layout for usability testing (QG-02) using a small stand-in with the same method
names; the bundler step that attaches the real `PosSession` as `window.posSession` lands with
the build pipeline. No network call exists anywhere in the sale path (enforced by
`tests/guardrails/pos-offline`).

Tested in `tests/unit/pos-session.test.ts`. Part of the repository layout in `CLAUDE.md`.
