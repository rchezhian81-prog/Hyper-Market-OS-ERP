// Public surface of @sre/self-checkout — the Stage 18 innovation wave (D04, D06, D14).
//
// Self-checkout, scan-and-go and the price kiosk (D04): intervene rarely, watch always, and
// never accuse anybody at the lane — the customer message is neutral in every case while the
// attendant message is specific, patterns are scored across a basket for the office rather
// than shown at the till, age verification is always a human, and the lane works with the
// internet down (hard rule #1).
//
// Price integrity across shelf, POS, app and ESL (D06, D14): the till is the reference because
// it is what the customer is charged; a shelf showing LESS than the till is a legal exposure
// ranked first whatever it is worth, a shelf showing more is margin ranked by value, a surface
// that has not confirmed is treated as unconfirmed rather than as agreeing, and an ESL price
// change waits for every label to echo it back before the till may move.

export * from './self-checkout';
export * from './price-integrity';
