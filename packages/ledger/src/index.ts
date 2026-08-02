// Public surface of @sre/ledger — the append-only ledger engine (hard rule #2,
// §31.1). Balances are projected from events, never overwritten; appends are
// idempotent. Grows one reviewed, tested unit at a time.

export * from './ledger';
