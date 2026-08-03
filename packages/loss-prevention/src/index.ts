// Public surface of @sre/loss-prevention — configurable anomaly rules
// (M15-FR-01): evaluate void/refund/discount/no-sale/cash activity against a
// store's thresholds and return linked exceptions to surface to the owner. Pure
// detection — it never acts. Grows one reviewed, tested unit at a time.

export * from './loss-prevention';
