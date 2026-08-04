// Public surface of @sre/storefront — the customer app and web storefront (M20).
//
//   • `browse.ts`   (M20-FR-01/02) — the same commerce truth as the till: no catalogue of
//     its own, items the lane would refuse are never shown as buyable, stock carries its
//     age, search tolerates typos, and personal recommendations are consent-scoped.
//   • `checkout.ts` (M20-FR-03/04) — serviceability and fees stated BEFORE the basket is
//     filled, slots that cannot be sold twice, a payment that is never assumed, tracking
//     that states its age, and a privacy centre showing everything held, including what
//     cannot be erased.
//
// Pure and deterministic: no clock, no network, no card data (hard rule #3).

export * from './browse';
export * from './checkout';
