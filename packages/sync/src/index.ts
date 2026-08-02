// Public surface of @sre/sync — the offline-first sync primitives (P-01, §31).
// Starts with the durable outbox (idempotent enqueue, visible unsent count,
// dead-letter that is never dropped). Grows one reviewed, tested unit at a time.

export * from './outbox';
