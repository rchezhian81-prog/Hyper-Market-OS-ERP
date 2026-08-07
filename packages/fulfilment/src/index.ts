// Public surface of @sre/fulfilment — picking to doorstep (M19).
//
//   • `delivery.ts` (M19-FR-01/03) — the delivery state machine and proof of delivery.
//   • `packing.ts`  (M19-FR-02) — a weighed line priced at its ACTUAL packed weight
//     (D09), a missing pack temperature treated as a failure, incompatible handling
//     refused in one crate, and a dispatch manifest derived from what was PACKED rather
//     than from what was ordered.
//   • `cod.ts`      (M19-FR-04) — cash-on-delivery reconciled to the paisa, with short,
//     over, uncollected and unexpected each a valued exception; never card data.

export * from './delivery';
export * from './packing';
export * from './cod';
export * from './routing';
