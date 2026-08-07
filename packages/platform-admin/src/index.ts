// Public surface of @sre/platform-admin — platform administration (M33): device and
// application-version control with a rollback path that survives a bad release
// (FR-02), time-boxed audited support access with no perpetual back door (FR-03),
// and the status centre reporting real health rather than its own (FR-04).
// Tenant settings, feature flags and config history (FR-01) live in
// `packages/tenant` and `packages/config`, which this composes.

export * from './devices';
export * from './support-access';
