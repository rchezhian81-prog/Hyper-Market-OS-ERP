// Public surface of @sre/workforce — M25.
//
// Rosters, gated tasks, checklists, incentives and SOP acknowledgement. This module governs
// people, so the failure modes are human: a gap reported as an average is a gap nobody
// acts on, a certification gate on the *person* is a gate people route around on a busy
// Saturday, and a bonus that pays "nearly" has redefined the target. Labour cost is the
// deliberate exception — reported, never enforced.

export * from './workforce';
// R2 addendum C18 — the TN Shops and Establishments working-time pack (every limit a setting, none hard-coded).
export * from './working-time';
// R2 addendum C20 — the Internal Committee complaints register and its annual report.
export * from './posh';
// OB-288 package 5 — access matches assignment (M25-FR-01), training and competency and the role curriculum (M25-FR-03 ·
// OB-320), productivity (OB-317), the QG-09 adoption gate (D11-FR-04), appointment letters (C17 · OB-323) and the
// shop's own SOP sheets as the built-in help library (M25-FR-04).
export * from './access-match';
export * from './training';
export * from './productivity';
export * from './adoption-gate';
export * from './appointment-letter';
export * from './sop-library.generated';
