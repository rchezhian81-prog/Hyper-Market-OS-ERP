// Public surface of @sre/owner-control — the owner's control surface (M29).
//
//   • `drill-through.ts` (M29-FR-02) — drill from a KPI to the immutable transactions
//     behind it, scope-enforced, and say so loudly when they do not add up.
//   • `alerts-inbox.ts` (M29-FR-03) — owner-set thresholds, GROUPED exception alerts,
//     and an approval inbox that flags an item the world has overtaken.
//   • `scheduled-brief.ts` (M29-FR-04) — the daily brief that sends itself, arrives
//     with or without AI, and carries a missed day rather than skipping it.
//
// Nothing here commits anything: approvals route to `packages/approvals`, and AI is
// additive and read-only throughout (hard rule #5 / AI-NFR-04).

export * from './drill-through';
export * from './alerts-inbox';
export * from './scheduled-brief';
