// Public surface of @sre/rbac — the default-deny access control engine (P-04,
// M02-FR-02). A named user may do only what an assigned role explicitly grants,
// within scope. Grows one reviewed, tested unit at a time.

export * from './rbac';
export * from './movement-jobs'; // OB-623 · OB-773: each stock role's own kinds of movement — one rule for head office and the store
