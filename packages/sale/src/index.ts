// Public surface of @sre/sale — the local POS sale commit (hard rule #1): commit
// locally first (fully-paid check, stock ledger, outbox), then sync idempotently.
// Composes the foundation. Grows one reviewed, tested unit at a time.

export * from './sale';
