// Public surface of @sre/promotions — the deterministic best-price engine
// (M05-FR-03): compute a basket's discount from the approved, effective-dated rule
// set (percent-off, amount-off/coupon, buy-X-get-Y, member price), never applying
// an expired or unpublished promotion, honouring exclusivity. Pure and identical
// online and offline. Grows one reviewed, tested unit at a time.

export * from './promotions';
