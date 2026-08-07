// Public surface of @sre/cash — till cash movements (M14-FR-01): float issue,
// loans, pickups and safe drops as an append-only cash chain, with one custodian
// per till and no overdraw. Balance and custodian are projected from the events.
// Grows one reviewed, tested unit at a time.

export * from './cash';
