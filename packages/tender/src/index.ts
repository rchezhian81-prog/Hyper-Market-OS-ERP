// Public surface of @sre/tender.
//
//   • `tender.ts` (M12-FR-03) — tender settlement: split tenders balance to the total,
//     and a pending or uncertain tender never counts as paid.
//   • `pending-recovery.ts` (D04-FR-02) — what happens when the card machine does not
//     answer: the tender stays `uncertain`, the sale still completes locally, and
//     recovery reconciles it against the provider's own record afterwards. There is no
//     way to resolve an uncertain tender by hand, in either direction.
//   • `card-token.ts` (C10) — a card tender keeps ONLY the network-token reference, the last four
//     digits and the network; any other field, and any value shaped like a card number, is refused.
//   • `tender-card-data.ts` (C10 · NEW-3) — a stored tender with card data REMOVED, and what was removed, by name.
//   • `legacy-card-purge.ts` (C10) — the legacy-card-purge check: a legacy extract passes only when
//     it holds no card number, security code or card expiry anywhere.
//   • `paid-on-old-erp.ts` (OB-256 · OB-258) — the mirror pilot's one non-cash tender: offered only in the mirror pilot,
//     then the only tender; refunds go back to it; no drawer money, no card/UPI attempt.
//   • `old-erp-bill-number.ts` (OB-264) — the old ERP's bill number on every mirror sale: Rule 46(b) shape, no personal
//     data, never keyed twice; a mirror refund finds its sale by it.
//
// Grows one reviewed, tested unit at a time.

export * from './tender';
export * from './pending-recovery';
export * from './card-token';
export * from './legacy-card-purge';
export * from './tender-card-data';
export * from './paid-on-old-erp';
export * from './old-erp-bill-number';
// OB-271: the shop's own card machine's / UPI's approval or reference number, typed from the slip — never card data.
export * from './machine-reference';
