// Public surface of @sre/fulfilment — delivery execution (M19-FR-03: auditable
// state machine + proof of delivery), customer-confirmed substitution (M19-FR-01),
// and COD reconciliation at shift end (M19-FR-04: cash/UPI only, valued exceptions).
// Pure and deterministic. Grows one reviewed, tested unit at a time.

export * from './delivery';
export * from './cod';
