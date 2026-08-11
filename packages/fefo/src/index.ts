// Public surface of @sre/fefo — FEFO allocation & the expiry action list
// (M10-FR-01): sell earliest-expiry first, never allocate expired/recall-blocked
// stock, and flag near-expiry (markdown) / expired (dispose) batches. Pure and
// deterministic. Grows one reviewed, tested unit at a time.

export * from './fefo';
export * from './assign-batches';
