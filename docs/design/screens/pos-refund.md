# Screen spec — Return / Refund (POS, Stage 3)

- **Surface:** POS (§27, "Return/exchange" state) · **Module:** M13 (FR-01…FR-04) · **Section:** §28 (approvals), §30.2, §31 (offline)
- **Design bar:** the same as the sale screen — a new cashier does it unsupervised after 30 minutes; every frequent action ≤ 3 interactions; it works with the network cable out for a receipted refund the lane can look up. **This is money leaving the drawer, so honesty beats speed at every fork.**

> Built on `../design-system.md` and consistent with `./pos-cashier.md`. This spec covers the
> **refund** path only. Exchanges (M13-FR-02) and return-window enforcement are **deferred** — the
> engine does not implement them and their policy numbers are owner-input-pending (`docs/requirements/M13.md:46`,
> `docs/requirements/open-questions.md` Q6). Do not invent them on the screen.

## What is authoritative vs owner-pending

- **Authoritative behaviour:** `docs/requirements/M13.md` FR-01…FR-04 (receipt + controlled no-receipt;
  at-most-once per line; reason + disposition resell/quarantine/damaged/scrap; refund never exceeds
  the original paid; card/UPI refund is a *pending* reversal, never assumed successful).
- **Authoritative governance (§28):** every refund needs an approver who **genuinely holds
  `pos.return.approve`** (owner / store-manager) and is **not** the cashier processing it. The
  approval **threshold defaults to 0** (every refund needs an approver) and is per-tenant server
  config — never read from the request.
- **Owner-pending numbers (do NOT hardcode):** return window, no-receipt cap, and any raised approval
  threshold. The screen consumes these as **injected policy** from the edge read model
  (`servicePolicy`), exactly as the engine consumes them as inputs. Absent a configured no-receipt
  cap, the **no-receipt path is unavailable** (fail safe), not defaulted to a guessed number.

## Screens & states (§27.1 universal states apply)

Look up receipt → **Select lines to return** (home) → Reason & condition → Refund method → (Approval, if required) → Confirmed / Pending / Refused. A **no-receipt** entry is a separate start that always routes through Approval.

## The Select-lines screen (home)

- **Layout:** the **receipt** at the top (number, date, paid total); a scrolling list of the bill's
  lines showing, per product, **sold / already returned / still returnable**; a per-line quantity
  stepper capped at what is still returnable; a running **refund total** (the largest element, as the
  sale screen's total is); one dominant **Refund** primary action; the permanent sync badge.
- **The cashier can never select more than is returnable.** The stepper is capped at
  `returnableMinor` (sold − already-returned, from the return register). The engine still enforces
  at-most-once independently (RR-F04) — the cap is the courtesy, the engine is the guard.
- **Refund total is shown, not typed**, and cannot exceed what is still refundable of the bill
  (paid − already-refunded). A refund above that is refused by the engine (M13-FR-03).

## Interaction budget (must be ≤ 3)

| Frequent action | Interactions |
| --- | --- |
| Look up a receipt | ≤ 3 (enter/scan number → find) |
| Return one whole line | ≤ 3 (tap line → confirm qty → Refund) |
| Choose a reason | 1 (tap a reason chip — never free text, M15) |
| Choose refund method | 1 (tap Cash / Original tender / Store credit) |
| Take a manager approval | +1 step **by design** (§28 separation of duties) — listed, not hidden |

## Offline & state behaviour (§31 / hard rules #1, #10)

- A **receipted** refund the lane can look up locally works **offline**: it is written to this till's
  edge disk first and only then is cash handed over (the sale path's order, for money out). Cash and
  store-credit refunds **settle at the lane**; a **card/UPI** refund is shown as **pending** — a
  reversal the provider has not performed yet — never as done (M13-FR-04).
- The refund is durable **before** it is called done. The receipt of durable confirmation is what
  lets the cashier hand back cash.

## Errors & the outcomes that must never be confused (§27.1)

Every outcome states what happened, whether money should move, and the next safe action. The screen
shows the **model's own words** (`laneMessage`) for the critical ones, never a reworded copy:

| Outcome | What the cashier must do |
| --- | --- |
| **Settled** (cash / store credit) | Hand over the refund; done. |
| **Pending** (card / UPI) | Tell the customer the reversal is on its way; do **not** hand over cash. |
| **Refused** (edge could not save) | Hand back **no** cash; use another lane / get the manager. |
| **Uncertain** (a reply was lost, RR-F02) | Do **not** hand back cash and do **not** run it again — get the manager to check whether it recorded first. |
| **Conflict** (id reused for different money, RR-F03) | Do **not** take payment/pay out — the id was used for a different refund; tell the manager. |
| **Not entitled** (over-return, RR-F04) | The goods were already returned — refuse; nothing is paid. |
| **Approval required** (§28) | Get a manager (not you) who is allowed to approve; then retry. |

**Uncertain is not failure.** Treating a lost reply as a definite failure is what causes a second
refund for money that already went back — the one mistake this screen exists to prevent.

## Accessibility & language

Large targets/contrast for arm's-length use under glare; ≥ 48px touch targets; English/Tamil toggle
persistent per cashier — **every** word on the screen carries Tamil, not a subset. Reasons are chips,
never free text.

## Acceptance (QG-02 / QG-04 / QG-05)

- An untrained cashier completes a one-line receipted cash refund unsupervised within 30 minutes.
- The stepper cannot offer more than is returnable; a second refund of the same goods is refused.
- A card refund shows **pending**, never a completed refund for money that has not moved.
- A material or no-receipt refund cannot be completed without a **separate** approver.
- Cable pulled → a locally-known receipted cash refund still completes durably and reconciles on sync;
  a lost reply reports **uncertain**, never a definite failure.

## Build order (slices, one reviewed PR each)

1. **The tested view surface** (`apps/pos/src/refund-view.ts`) — display-primitive bridge over the
   tested engine + `till.refund()`, mapping every outcome above to a plain-English screen state. No DOM.
2. **The on-screen panels** — replace the honest "not built yet" stub in `apps/pos/web/app.js` with
   the real flow bound to the view surface.
3. **The end-to-end check** — a cashier completes a refund on the served shell, offline.
