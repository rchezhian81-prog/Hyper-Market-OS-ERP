// Public surface of @sre/orders — one order lifecycle (M18).
//
//   • `lifecycle.ts`       (M18-FR-01) — an auditable state machine where only allowed
//     transitions apply.
//   • `reservation.ts`     (M18-FR-02) — stock reserved so the store never oversells;
//     available-to-promise = on-hand − reservations, projected from an append-only ledger.
//   • `fulfilment-plan.ts` (M18-FR-03) — pickup, scheduled and express routing across
//     stores and dark stores, where capacity is real, express needs stock HERE AND NOW,
//     and an unprofitable drop is flagged rather than blocked (D09).
//   • `amendments.ts`      (M18-FR-04) — a cancellation that releases the reservation in
//     the same act, a substitution that is never applied without the customer's
//     confirmation, and channel reconciliation checked in BOTH directions.
//
// Pure and deterministic. Grows one reviewed, tested unit at a time.

export * from './lifecycle';
export * from './reservation';
export * from './fulfilment-plan';
export * from './amendments';
