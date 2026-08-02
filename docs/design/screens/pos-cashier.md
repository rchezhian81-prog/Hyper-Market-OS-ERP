# Screen spec — Cashier POS (Stage 3)

- **Surface:** POS (§27) · **Modules:** M12–M15, D04 · **Priority:** the critical, most-used surface
- **Design bar:** a new cashier bills unsupervised after 30 minutes; every high-frequency action ≤ 3 interactions; the core sale works with the network cable out.

> Screen specifications built on `../design-system.md`. Interaction counts are the
> Stage 3 acceptance target (QG-02); verify with `../usability-test-script.md`.

## Screens & states (§27 POS row)
Login/device · Opening till · **Sale (home)** · Product search · Customer ·
Promotion · Tender · Suspended bills · Return/exchange · Cash movements ·
Close · Offline/sync health. Each handles the §27.1 universal states.

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
