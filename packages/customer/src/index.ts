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
//   • `child-data-guard.ts` (C4 / DPDP s.9) — a child's data (under 18) is processed only
//     with verifiable parental consent, and tracking / targeted advertising of a child is
//     prohibited outright; age unproven refuses a child-restricted activity.
//   • `breach-notification.ts` (C2 / DPDP s.8(6)) — a personal-data breach becomes the
//     notification workflow the law requires: the Data Protection Board (immediate + a
//     72-hour report) and every affected person, each with prescribed content; a person sends.
//   • `consent-notice.ts` (C1 / DPDP s.5–6) — a consent notice must itemise each data
//     category with its purpose and carry in-notice withdraw / grievance / Board links, with
//     withdrawal as easy as giving; every gap is a named defect.
//
// Pure and deterministic. Grows one reviewed, tested unit at a time.

export * from './matching';
export * from './consent';
export * from './data-rights';
export * from './segments';
export * from './child-data-guard';
export * from './breach-notification';
export * from './consent-notice';
