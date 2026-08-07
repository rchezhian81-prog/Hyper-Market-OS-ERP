// Public surface of @sre/platform — M36, the commercial multi-tenant layer (ADR-0003).
//
// Plans, entitlements and metering where a limit is reported and invoiced but NEVER stops a
// shop trading (FR-01); white-label branding from configuration with no code fork, falling
// back to neutral rather than to another tenant's mark (FR-02); tenant export that refuses to
// call itself complete when it is not, closure that respects statutory retention and never
// touches audit evidence, and upgrade compatibility judged against who is actually still
// calling (FR-03); and a partner ecosystem where a sandbox credential can never reach
// production and production data can never reach a sandbox (FR-04).
//
// Builds on `packages/tenant` (entitlements, settings) and `packages/config` (versioned
// per-tenant configuration), both live since Stage 5.

export * from './plans';
export * from './branding';
export * from './lifecycle';
export * from './partner';
