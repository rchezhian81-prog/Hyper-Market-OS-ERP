// Public surface of @sre/customer — one customer truth (M16).
//
//   • `matching.ts`   (M16-FR-01) — duplicate detection that never auto-merges.
//   • `consent.ts`    (M16-FR-02) — consent enforcement that blocks a breaching send.
//   • `data-rights.ts`(M16-FR-03) — access, correction, export and erasure, where the
//     customer's right to be forgotten meets the law's requirement to keep records:
//     erase what can be erased, keep what must be kept, and tell the customer exactly
//     which is which and why.
//   • `segments.ts`   (M16-FR-04) — segments and lifetime value as **derived opinions
//     about a person**: no profiling without a lawful basis, service kept separate from
//     marketing, and value measured in margin rather than revenue.
//
// Pure and deterministic. Grows one reviewed, tested unit at a time.

export * from './matching';
export * from './consent';
export * from './data-rights';
export * from './segments';
