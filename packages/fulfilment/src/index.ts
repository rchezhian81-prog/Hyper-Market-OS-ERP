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
// OB-288 fulfilment & delivery package (M19-FR-01/03 · WF-14/15 · D08-FR-05 · D09-FR-05/06 · OB-294 · OB-300 · OB-313):
//   • `wave-plan.ts`        — a picker's wave built from confirmed orders (bins from the register, prices from the pack),
//                              an order never split;
//   • `proof-capture.ts`    — the 4-digit delivery code, the proof location judged against the stored address, captured images;
//   • `delivery-eta.ts`     — the customer's last-stop count and ETA from the route (an estimate, said so);
//   • `delivery-economics.ts` — the contribution rule (threshold "not set" → flag only), fleet settlement, the courier link (off);
//   • `sha256.ts`           — a synchronous digest for the phone's offline fingerprint of a captured image.
export * from './wave-plan';
export * from './proof-capture';
export * from './delivery-eta';
export * from './delivery-economics';
export * from './sha256';
