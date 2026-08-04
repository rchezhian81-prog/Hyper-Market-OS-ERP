// Public surface of @sre/ops — observability (M35-FR-03): health computed from
// evidence with sync lag, queue depth, dead letters, catalogue freshness and backup
// age; owned, escalating alerts (M35-FR-04); and structured logging that redacts
// secrets, card data and personal data by construction (hard rules #3 and #4).

export * from './health';
export * from './logging';
