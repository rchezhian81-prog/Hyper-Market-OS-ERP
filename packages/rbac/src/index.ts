// Public surface of @sre/rbac — the default-deny access control engine (P-04,
// M02-FR-02). A named user may do only what an assigned role explicitly grants,
// within scope. Grows one reviewed, tested unit at a time.

export * from './rbac';
