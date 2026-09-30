# Screen spec — Store / Manager (Stage 3)

- **Surface:** Store/Manager (§27) · **Modules:** M02 (approvals), M04/M09 (tasks), M14 (close), M25 (staff), M15 (exceptions) · **Design bar:** run the floor by exception; approvals fast; nothing important hidden.

> Built on `../design-system.md`.

## Screens & states (§27 Store/Manager row)
Opening checklist · Live trading · Approval inbox · Price tasks · Replenishment ·
Incidents · Staff tasks · Close · Exceptions. All handle the §27.1 states.

## Live trading (home)
- **Layout:** live lane/sales status, the **approval inbox** count, open exceptions, and today's tasks; sync-state badge always visible.
- **Primary action:** clear the next approval or exception.
- **Interaction budget (≤3):** approve/reject a request (≤3) · open a lane's health (≤2) · assign/complete a task (≤3) · start day close (≤2).

## Approval inbox
- Maker-checker requests routed by scope/value (M02-FR-03); one-tap decide with reason; separation of duties enforced (a manager can't approve their own).

## Tasks & replenishment
- Opening/closing checklists (D11-FR-01), price-change tasks (M05), shelf replenishment (M04-FR-03) routed to the right person (M25); completion is queued offline and synced.

## Incidents & exceptions
- Loss-prevention and operational exceptions (M15) surfaced with next action; incidents logged (M34/M26).

## Offline / state (§31)
- Tasks and checklists cached to the device; completion queues; approvals are online but the queue and freshness are always visible.

## Close (M14-FR-04)
- Guided day close aligned to the trading-day rule; blocked while unresolved exceptions/unsent sales remain; controlled, audited reopen.

## Acceptance (QG-02)
- A manager clears an approval in ≤3 taps with a reason recorded.
- Day close is blocked with a clear list when exceptions remain.
- Tasks route to the right staff and complete offline.

## Measured (Stage G slice 5c)
- The served screen runs as the person the store pack names (`managerPolicy.userId`), in the pack's branch, on the
  shop's trading day, up to the pack's approval limit. It shows "Running as <id>" in the header.
- When the pack names nobody, the screen says so (the nobody strip) and lists what is waiting but refuses every
  decision, receipt, count and close with that reason — never a stand-in identity (§28, hard rule #4).

## Measured (SP-2a, 30 September 2026 — audit finding F11)
- A decision is on THIS DEVICE before the screen says "Decided" (a durable device queue per store,
  `sre.manager.outbox.<storeId>`), and the banner says where it is: *Saved on this screen* until the store computer takes
  it. It survives a reload and a browser restart; the decided request is no longer offered; deciding it again is refused
  ("This screen has already decided that request").
- "Decided on this screen" lists every decision with one of five states, in English and Tamil: saved on this screen ·
  saved on this screen, trying again · with the store computer · posted at head office · refused (with the reason). The
  store computer is asked after each decision and every ten seconds; "posted" is only ever the store computer's word.
- Work held on this screen counts on the "Not yet sent to cloud" tile ("N saved on this screen") and blocks the day close
  until the store computer has taken it (M14-FR-04).
- Measured in a real browser against a real box (`tests/e2e/manager-decisions-survive-reload.e2e.ts`): decide (3 taps,
  unchanged) → with the store computer within a moment → reload → still decided, not offered again; with the box's socket
  gone → saved here, trying again, survives a reload, never shown as sent or refused.
- (Closed by SP-2b below.) Receipts and counts were saved on the device and counted as unsent but did not yet reach head office.

## Measured (SP-2b, 30 September 2026 — audit finding F11, second half)
- A delivery booked in on this screen travels the SAME path as a decision: saved on this device first, handed to the store
  computer, sent to head office as a full goods receipt. Head office re-checks it — who booked it in (from their own
  grants), the item's batch rule (from the published catalogue), what it cost (its own valuation), what was ordered (the
  purchase order) — and records anything it could not verify as a flag on the receipt, never as a silent zero. A tracked
  item with no batch is refused there and shows on this screen as *Refused*, with the reason.
- A count entered here is CAPTURED BLIND and RECONCILED AT HEAD OFFICE. This screen no longer works out the expected
  quantity, the difference, its value or whether it needs approval — and cannot, structurally: the model has no product
  value or threshold in it. The banner says "Count recorded" and where the count is; head office computes the expected
  figure against its own ledger, values the difference at its own cost, applies the store's count policy, corrects a
  small difference at once and HOLDS a large or unvalued one for a separate person. Before SP-2b a count after a reload
  was reconciled against an empty in-memory ledger and invented a variance; there is no longer any figure on this path
  to be wrong.
- "Saved on this screen" (renamed from "Decided on this screen") lists decisions, deliveries and counts alike, each with
  its kind (Decision · Delivery · Count, EN/TA) and one of the five states; a count row shows what was counted, never
  what was expected.
- Measured in a real browser against a real box (`tests/e2e/manager-decisions-survive-reload.e2e.ts`): book a delivery in
  (no purchase order — said) → with the store computer; count 94 on the keypad → "Count recorded", no expected figure
  anywhere → with the store computer; the box's log holds the whole receipt and only the counted figure → reload → both
  still listed, nothing held on the screen.
- Still open: a held material count variance is approved-then-applied in SP-4; the counts review screen does not yet
  list relayed counts (SP-9); the handhelds join the same path in SP-3.

## Measured (SP-8b, 30 September 2026 — audit finding F08, the floor indent register and approval)
- The manager's pending-indents / in-transit register is the served **Floor indents** screen (`/indents`, Inventory
  group, `inventory.indent.read`) — not a tile on this screen, on purpose: one register for the floor, the counter and the
  manager, read live from head office. The manager APPROVES there with a reason (`inventory.indent.approve`), only an ask
  somebody else raised; their own ask is never offered and is refused before anything is sent (§28). The approval is an
  online write under the manager's own session — never a body field naming the approver — and head office's refusal is
  shown verbatim.
- Measured in a real browser (`tests/e2e/indents-delivery.e2e.ts`): the register ordered asks-first with the figures head
  office holds; Approve offered only for the floor's ask; the POST carries `{ reason }` and an idempotency key and nothing
  else; the ask no longer waits after the re-read; the manager's own ask refused with nothing sent.
- Still open: the back-store issue against the indent on the handheld (SP-8c); the manager's home tile counting open
  indents is not built (P-03 says the register is where the work is, not a second count on this screen).
