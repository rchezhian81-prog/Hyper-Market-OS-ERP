// Public surface of @sre/concession — M27.
//
// A counter inside the shop that is NOT the shop's business. Ownership is a property of the
// stock and valuation asks (FR-02) — concession stock never lands in the store's balance
// sheet, insurance schedule or tax position, and what was excluded is named. The money a
// concession sale takes is held on someone else's behalf, so it is a liability discharged at
// settlement, never the shop's revenue (FR-01, FR-03). A deposit is projected from movements
// and a forfeit needs a name (FR-01). Lapsed insurance or a dead agreement blocks new sales,
// and every blocker is reported at once (FR-04).
//
// A per-tenant optional feature (ADR-0003), built where a store runs concessions.

export * from './concession';
