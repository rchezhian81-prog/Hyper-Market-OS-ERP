// Public surface of @sre/replenishment — reorder suggestions (M09-FR-02): compute
// what to reorder and how much from per-product parameters, as an advisory proposal
// a buyer approves (never an automatic PO — hard rule #5 / AI-NFR-12). Pure and
// deterministic. Grows one reviewed, tested unit at a time.

export * from './replenishment';
export * from './constrained-order';
