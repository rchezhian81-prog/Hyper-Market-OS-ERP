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
