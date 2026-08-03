// Public surface of @sre/customer — one customer truth (M16): duplicate detection
// that never auto-merges (M16-FR-01) and consent enforcement that blocks a breaching
// send (M16-FR-02). Pure and deterministic. Grows one reviewed, tested unit at a time.

export * from './matching';
export * from './consent';
