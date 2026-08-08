// Public surface of the Warehouse app (M09 / OA-9) — the offline, scanner-first handheld session:
// receive at the back door, put stock away into bins, with every stock rule delegated to the
// authoritative engines (packages/receiving, packages/warehouse, packages/fefo) and every accepted
// action queued for idempotent sync. Synchronous and local, so it works with no signal (P-01, §31).

export * from './warehouse-session';
export { bootWarehouse } from './browser-entry';
