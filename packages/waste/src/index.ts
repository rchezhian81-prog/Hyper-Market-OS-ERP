// Public surface of @sre/waste — M28.
//
// Write-offs (FR-01): wastage / damage / expiry / donation / destruction recorded as a
// reason-coded compensating stock movement, with a separate approver and captured evidence
// for a material loss, valued for finance. Scrap and recycling (FR-02): proceeds made to
// exist and posted, with rate drift measured against the shop's own history rather than a
// configured guess. Packaging (FR-03): a bag charge is a visible priced line or it does not
// exist, and reusable crates are projected in circulation instead of assumed consumed.
// Reporting (FR-04): every waste figure carries its reporting coverage, and a fall in
// recorded waste on falling coverage is reported as "we cannot tell".

export * from './waste';
export * from './scrap';
export * from './packaging';
export * from './sustainability';
