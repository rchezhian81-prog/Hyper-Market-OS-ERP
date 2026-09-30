# Screen spec — Cashier POS (Stage 3)

- **Surface:** POS (§27) · **Modules:** M12–M15, D04 · **Priority:** the critical, most-used surface
- **Design bar:** a new cashier bills unsupervised after 30 minutes; every high-frequency action ≤ 3 interactions; the core sale works with the network cable out.

> Screen specifications built on `../design-system.md`. Interaction counts are the
> Stage 3 acceptance target (QG-02); verify with `../usability-test-script.md`.

## Screens & states (§27 POS row)
Login/device · Opening till · **Sale (home)** · Product search · Customer ·
Promotion · Tender · Suspended bills · Return/exchange · Cash movements ·
Close · Offline/sync health. Each handles the §27.1 universal states.

## Login / who is on the till (SP-4b · F09 · §28 · hard rule #4)
- The header always names **which lane** this till is and **who is signed in** — or says "Nobody signed in". Neither is
  ever a stand-in: the lane is the store computer's own setting (`EDGE_LANE_ID`), the cashier is the person who signed in.
- **Sign in** (top right): scan your badge or key your staff code, then OK — one panel, the same scan-or-key control the
  refund approval uses. **Sign out** is the same button. A reload of this browser session keeps the sign-in; closing the
  browser does not (a till left open overnight starts with nobody).
- With **nobody signed in**, or **no lane set**, Tender, refunds, cash movements and Close are refused in words — the
  money is never taken first.
- Every sale, refund, cash movement and close names the signed-in cashier, the lane and the **trading day worked out at
  that moment** from the shop's cut-off (M01-FR-02) — so a till left open past the cut-off moves to the new day by itself.
- Head office re-verifies the cashier a sale names against their grants; an unknown or unauthorised name is a finding on
  the manager's exception register, never a refusal of a sale that happened.
- **Pending (GAP-POS-LOGIN-01):** the staff code *identifies*; it does not *authenticate*. A credential-checked till login
  (PIN / badge verified against the store computer, offline-capable) is the remaining piece of the Login screen.

## Cash movements and Close till (SP-4c · F10 · M14-FR-01 · M14-FR-02)
- **The till keeps no cash figure of its own.** Every float, pickup and the close is recorded on the **store computer**,
  durably, before the cashier is told "Recorded on the store computer". A browser reload changes nothing: the till asks the
  store computer whether a float is out and offers only what fits — **Take float (open the till)** when nothing is out;
  **Cash to safe** and **Close till** when a float is out.
- **Take float** opens the shift in the signed-in cashier's name; a second float while one is out is refused in words. Only
  the cashier who took the float can close the till or move its cash.
- **Cash to safe** is refused in words when the drawer cannot hold it (the store computer knows the float AND the cash
  taken in trade), and the refusal is never a figure.
- **Close till:** count the drawer by denomination — nothing on the panel says what should be there. The store computer works
  out float + cash sales − pickups − cash refunds from what it itself recorded, and answers with the difference. Within
  tolerance: "The drawer balances exactly." / "Over by ₹…" / "Short by ₹…" and "Till closed". Beyond the shop's tolerance
  the till asks **why**, from chips (wrong change given · miscounted · the float was wrong · cash moved without recording ·
  cannot explain — never free text), then closes and tells the cashier to call the manager before the money is put away.
- **A lost reply moves nothing twice.** A movement the store computer did not answer is kept on the till with its own id and
  sent again first thing next time; the store computer answers "already recorded" for a repeat.
- Head office re-verifies every relayed movement and close (the custodian, the cashier, the chain, the arithmetic) and
  flags — never refuses — what disagrees; a material short opens a loss-prevention investigation.

## The Sale screen (home) — the one that matters most
- **Layout:** big running **total** (largest element), scrolling line list, large number pad, one dominant **Tender** primary action, permanent **sync-state badge** (online/offline + unsent count) top corner.
- **Primary action:** Tender. Everything else is secondary.
- **Interaction budget (must be ≤ 3):**
  | Frequent action | Interactions |
  | --- | --- |
  | Scan an item | 1 (scan) |
  | Change quantity | ≤ 3 (tap line → qty → confirm) |
  | Sell a weighed item | ≤ 3 |
  | Go to tender | 1 (Tender) |
  | Take cash payment | ≤ 3 (Tender → Cash → confirm) |
  | Suspend / recall | ≤ 3 |
  | Sign in for the shift (once a shift, not per sale) | 2 (Sign in → badge scan) |
- **Exceptions to ≤3 (justified):** first-time customer capture and age-verification prompts add a step **by design** (legal/consent) — listed here explicitly, not hidden behind "where feasible".

## Offline & state behaviour (§31 / hard rule #1)
- The sale **never waits on the network**; cash/store-credit tender completes locally and prints.
- Card/UPI shows **pending/declined honestly** — never a fake approval.
- Sync-state badge always visible; tapping the unsent count lists queued sales.
- If a peripheral (scanner/printer/scale) is unhealthy, the lane shows it with the next safe action.

## Errors (§27.1)
Every error states: what happened · whether the sale was saved · the next safe
action (e.g. "Card not confirmed. Sale NOT completed. Try another tender or retry.").

## Accessibility & language
Large targets/contrast for arm's-length use under glare; English/Tamil toggle
persistent per cashier; number pad and totals oversized.

## Acceptance (QG-02 / QG-04 / QG-05)
- Untrained cashier bills a full basket unsupervised within 30 minutes.
- Every action in the table above measured ≤ 3 interactions on the real device.
- Cable pulled mid-basket → sale completes and prints; unsent count increments; syncs once on reconnect.
- Scan-to-line feels instant (backs the ≤300 ms p95 target, §32).

## Related screens (specified next in this folder)
Owner command centre · Store/Manager · Purchase/Supplier & receiving handheld ·
Inventory/Warehouse · Customer app · Picker · Delivery · CRM/Service · Admin ·
Migration · AI control.

## Measured (Stage G slice 5c)
- A product whose unit of measure the till cannot price never reaches the lane: the store computer keeps it off the
  till's catalogue and names it (`excludedProducts`), and the catalogue engine refuses the scan by name should one
  arrive another way. A line is never ₹NaN.

## Measured (SP-4b)
- The served till boots with the box's lane and cut-off and **no cashier**; a sale is refused until somebody signs in, then
  names the real cashier, lane and day (`tests/audit-observations/pos.test.ts` case 1, inverted from the F09 observation;
  `tests/e2e/the-served-till-takes-a-sale.e2e.ts` in real Chromium, including a reload that keeps the sign-in).
- The till's float, pickup and blind-count close run against the real store box from the screen, and a reload mid-shift
  still knows a float is out; a short second shift is refused until a reason chip is chosen, then closes with "call the
  manager" (`tests/e2e/the-served-till-closes.e2e.ts`, real Chromium; `tests/integration/the-till-closes-through-the-box.test.ts`
  on the real lane socket). The Close button's input is exactly shift, moment, count and reason — the F10 observation
  inverted (`tests/audit-observations/pos.test.ts`). That browser test also found that the keypad stayed on screen above
  the reason chips (an author `display: grid` beat the browser's `[hidden]`), pushing OK below a 720px viewport on every
  reason sheet — the till's hidden panels now hide (`apps/pos/web/index.html`).
- Signing in costs two acts (Sign in → badge scan), counted on the served screen
  (`tests/e2e/the-till-and-manager-meet-the-interaction-budget.e2e.ts`). That browser test also found that a scanner's
  closing Enter, landing on the still-focused Sign in button, re-clicked it and signed the cashier straight back out; every
  scan-or-key prompt now drops the opener's focus first (`askScanOrKey` in `apps/pos/web/app.js`).
