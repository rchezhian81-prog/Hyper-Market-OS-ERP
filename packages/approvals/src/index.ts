// Public surface of @sre/approvals — the maker-checker approval engine (§28
// separation of duties, M02). The maker can never decide their own request.
//
// Plus delegation (M02-FR-03): the manager goes on leave and the shop still needs refunds
// authorised. Every business solves this, and most solve it by SHARING THE LOGIN — which
// does not merely break separation of duties, it erases the audit trail permanently. So
// delegation exists to make the honest route easier than the dishonest one: a delegate acts
// as themselves under somebody else's named authority, time-boxed, never wider than the
// granter holds, never chained, and never used to approve the granter's own requests.

export * from './approvals';
export * from './delegation';
