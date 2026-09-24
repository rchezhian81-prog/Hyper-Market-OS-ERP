// Public surface of @sre/fulfilment — picking to doorstep (M19).
//
//   • `delivery.ts` (M19-FR-01/03) — the delivery state machine and proof of delivery.
//   • `packing.ts`  (M19-FR-02) — a weighed line priced at its ACTUAL packed weight
//     (D09), a missing pack temperature treated as a failure, incompatible handling
//     refused in one crate, and a dispatch manifest derived from what was PACKED rather
//     than from what was ordered.
//   • `cod.ts`      (M19-FR-04) — cash-on-delivery reconciled to the paisa, with short,
//     over, uncollected and unexpected each a valued exception; never card data.
//   • `serviceability-simulator.ts` (M18-FR-01/FR-03, D08/D09) — a deterministic DRY RUN of the whole
//     delivery decision (policy-on-date → serviceability → routing) over synthetic addresses, baskets
//     and slots, so the chain is verifiable before live maps or the owner's final numbers. Composes
//     `resolveServiceabilityPolicy` + `checkServiceability` + `routeOrder`; flags a serviceable order
//     that no location can fill; distances are straight-line and say so.

export * from './delivery';
export * from './packing';
export * from './cod';
export * from './routing';
export * from './serviceability-simulator';
