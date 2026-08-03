// Public surface of @sre/receiving — the local goods-receipt commit (M07): append
// inbound stock to the ledger and queue the receipt for sync, offline-capable and
// idempotent. Grows one reviewed, tested unit at a time.

export * from './receiving';
export * from './capture';
export * from './three-way-match';
