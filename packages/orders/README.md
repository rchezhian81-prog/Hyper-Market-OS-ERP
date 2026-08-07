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

- **`src/fulfilment-plan.ts`** (M18-FR-03) — pickup, scheduled and express routing across
  stores and dark stores. The decision is made **explicitly with the reason recorded**,
  rather than defaulting to "the nearest shop" — the rule that quietly sends a ₹200 order on
  a 9 km round trip. Three things it refuses to pretend: **capacity is real** (a slot with
  eight vans is a slot with eight vans, and a ninth is a customer waiting in for nothing);
  **express is a different promise** (it needs stock at that location *now*, not "in the
  chain somewhere"); and a **dark store can never serve a pickup**, because there is no shop
  floor to walk into. `assessContribution` prices the drop and **flags an unprofitable one
  without blocking it** (D09) — the shop may well want the customer, it just must not take
  the order believing it made money.
- **`src/amendments.ts`** (M18-FR-04) — `cancelOrder` returns **every reservation to
  release as part of the same result**, never leaving it to a caller to remember: a
  cancellation that forgets the release makes stock invisible to the shop floor, and it is
  the commonest cause of phantom out-of-stocks. `applySubstitution` treats **no answer as a
  no** (A04): an unconfirmed substitute is never picked, never charged and never delivered,
  because a picker swapping products is deciding about someone else's dinner, diet or
  religion. A dearer substitute is charged at the **original** price; a cheaper one is
  charged cheaper and the difference **refunded, not kept**. `reconcileChannel` checks
  **both directions** — an order the channel has and we do not is a customer waiting for
  something nobody is picking; one we have and it does not is a phantom that will never be
  paid for.

> Tested in `tests/unit/orders-fulfilment-plan.test.ts` (12) and
> `tests/unit/orders-amendments.test.ts` (15), and proven end to end in
> `tests/integration/pick-to-doorstep.test.ts` (Stage 15 gate).
