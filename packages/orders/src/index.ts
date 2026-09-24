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
//   • `substitution-policy.ts` (M19-FR-01) — BEFORE the money: given a customer's preference
//     (no substitution / best match / contact me) and their brand/category/size/allergen
//     restrictions, decides whether a substitute may be offered at all, and whether the shop
//     may pick it (`best_match`) or must ask first (`contact_me`). Controlled items are never
//     auto-substituted. Composes with `amendments.applySubstitution`, which does the money.
//   • `substitution-money.ts` (M19-FR-01) — HOW the money moves once a swap is decided: a cheaper
//     swap or a short-pick is a refund (prepaid) or a smaller total to collect (COD/pay-at-store);
//     a dearer swap is capped at the original price unless the customer EXPLICITLY approved paying
//     more. Composes `applySubstitution`; basket promo/tax/loyalty recompute is the next slice.
//   • `substitution-exceptions.ts` (M19-FR-01) — the OWNED, VALUED worklist of swaps a person must act
//     on (refund due, collect adjustment, above-cap charge, policy short-pick), worst first, so a swap
//     that owes money or left the customer short is never silent (P-08).
//   • `substitution-messages.ts` (M19-FR-01, P-07 §19) — the customer-facing message for a substitution
//     outcome in English OR Tamil, so the notification the customer receives speaks their language.
//
// Pure and deterministic. Grows one reviewed, tested unit at a time.

export * from './lifecycle';
export * from './reservation';
export * from './fulfilment-plan';
export * from './amendments';
export * from './substitution-policy';
export * from './substitution-money';
export * from './substitution-exceptions';
export * from './substitution-messages';
