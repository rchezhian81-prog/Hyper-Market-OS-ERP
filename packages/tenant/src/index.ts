// Public surface of @sre/tenant — tenants and per-tenant feature entitlements
// (ADR-0003; M33/D12/M36). Each tenant chooses which optional modules/departments
// it runs; optional features are default-off. Grows one reviewed, tested unit at a time.

export * from './tenant';
