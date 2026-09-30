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
- Still open: receipts and counts are saved on the device and counted as unsent but do not yet reach head office (SP-2b).
