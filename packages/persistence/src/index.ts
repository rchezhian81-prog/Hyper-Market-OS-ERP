// Public surface of @sre/persistence — the durable persistence layer scaffolding:
// the driver-agnostic SqlClient port and the tenant-scoped, append-only EventStore
// (in-memory reference + SQL adapter). Grows one reviewed, tested unit at a time.

export * from './sql-client';
export * from './event-store';
export * from './outbox-store';
