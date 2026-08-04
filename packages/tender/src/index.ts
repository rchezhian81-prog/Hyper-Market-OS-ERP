// Public surface of @sre/tender.
//
//   • `tender.ts` (M12-FR-03) — tender settlement: split tenders balance to the total,
//     and a pending or uncertain tender never counts as paid.
//   • `pending-recovery.ts` (D04-FR-02) — what happens when the card machine does not
//     answer: the tender stays `uncertain`, the sale still completes locally, and
//     recovery reconciles it against the provider's own record afterwards. There is no
//     way to resolve an uncertain tender by hand, in either direction.
//
// Grows one reviewed, tested unit at a time.

export * from './tender';
export * from './pending-recovery';
