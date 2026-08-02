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
