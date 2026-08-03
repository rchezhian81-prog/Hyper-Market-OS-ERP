# `packages/orders/`

Order management — one order lifecycle across channels (**M18-FR-01**) and stock reservation
with **no oversell** (**M18-FR-02** / §6.2).

- **`src/lifecycle.ts`** — `transitionOrder(from, event)`: an **auditable state machine**
  (`placed → confirmed → picking → packed → dispatched → delivered` / `collected`, or
  `cancelled`). Only allowed transitions apply; an illegal one throws
  `InvalidOrderTransitionError`. Helpers: `canTransition`, `isTerminal`, `canCancel`
  (cancellable up to `packed`, releasing the reservation — M18-FR-04).
- **`src/reservation.ts`** — `reserveStock(input, reservationLedger, outbox, physicalOnHand)`:
  reserves stock only within **available-to-promise** (physical on-hand − active reservations),
  refusing anything more with `OversellError` — reserved stock is **not sellable to a walk-in**
  (M08-FR-02). Reservations are **append-only** events; `reservedQty` and `availableToPromise`
  are **projected** from them (never stored). `releaseReservation` is a compensating release
  (e.g. on cancellation). Idempotent on the reservation id.

> The reservation ledger is a separate `Ledger` from the stock ledger; the caller supplies the
> physical on-hand (projected from the stock ledger via `packages/counts` `onHandMinor`).
> Composes `packages/ledger` and `packages/sync`. Tested in `tests/unit/orders.test.ts`. Part
> of the repository layout in `CLAUDE.md`.
