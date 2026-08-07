// Public surface of @sre/loyalty — M17.
//
//   • `loyalty.ts`      (M17-FR-01) — points as money-like append-only movements, with
//     the balance projected and an offline burn cap.
//   • `coupons.ts`      (M17-FR-02) — coupons, referrals, memberships and personalised
//     offers, all validated at REDEMPTION rather than at issue, and offline-safe.
//   • `stored-value.ts` (M17-FR-03/04) — gift cards and store credit as **liabilities**:
//     balances projected from append-only movements, offline redemption capped rather
//     than forbidden, household pooling, and a cross-channel double-spend surfaced as a
//     valued exception with both movements kept (never last-write-wins).

export * from './loyalty';
export * from './coupons';
export * from './stored-value';
