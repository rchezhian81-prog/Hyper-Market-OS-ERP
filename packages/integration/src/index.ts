// Public surface of @sre/integration — M32, the safe seams between us and the outside world.
//
// Versioned APIs where a replay returns the FIRST answer rather than producing a second
// effect, a reused key with a different body is a conflict rather than a silent replay, and a
// webhook is signed with its timestamp inside the signature (FR-01). A connector SDK where an
// unmapped field is an exception rather than a dropped field, retries are bounded, a permanent
// error skips them, and a dead letter is read but never deleted — there is no purge function
// in this package (FR-02). Managed secrets that this module can only ever hold a vault
// REFERENCE to, rotation with an overlap and revocation without one, and usage signals that
// are surfaced but never auto-blocked (FR-03). And a certified adapter matrix where an
// uncertified device is refused with a named alternative, a payment adapter admitting it
// retains a PAN cannot be registered at all, and integration health is measured by when
// something last actually worked (FR-04).

export * from './api-gateway';
export * from './connector';
export * from './secrets';
export * from './adapters';
