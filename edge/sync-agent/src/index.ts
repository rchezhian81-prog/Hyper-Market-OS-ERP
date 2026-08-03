// Public surface of the store-edge sync agent (P-01 / §31) — drains the offline
// outbox to the cloud in order, idempotently, with retry, backoff and a visible
// dead-letter that never drops work. Deterministic and clock-free. Grows one
// reviewed, tested unit at a time.

export * from './transport';
export * from './agent';
