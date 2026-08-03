// Public surface of @sre/reporting — owner KPIs (M29-FR-01 / D13): exact sales/
// margin/basket/tender aggregation, and a data-freshness indicator so stale or
// missing data is never shown as fresh. Pure and deterministic. Grows one reviewed,
// tested unit at a time.

export * from './sales-summary';
export * from './freshness';
