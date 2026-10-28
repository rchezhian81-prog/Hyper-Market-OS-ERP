// Public surface of @sre/price-guard — margin-floor / MRP price controls
// (M05-FR-02): reject a price above MRP, and block a below-floor / below-cost price
// until a separate approver signs off with a reason. Exact and offline-deterministic.
// Grows one reviewed, tested unit at a time.

export * from './price-guard';
export * from './till-override'; // OB-500: the till's price-cut floor and manager limit
