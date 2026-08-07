// Public surface of @sre/period-close — M23-FR-04.
//
//   • `tally-connector.ts` — idempotent, versioned posting to Tally with computed
//     backoff and a **visible** dead-letter queue that is never drained by deletion.
//     Tally is a destination, not the book of record: a failed posting never changes
//     our own numbers.
//   • `period.ts` — control totals computed from two independent sides and compared
//     exactly, a close that returns every blocker at once, a reopen that needs a
//     separate approver, corrections routed to the open period as compensating
//     entries, and the CA-signable evidence pack.

export * from './tally-connector';
export * from './period';
export * from './control-totals';
