// Public surface of @sre/supplier-portal — M24.
//
// The only place in the product where someone OUTSIDE the business logs in, which makes
// it the highest-risk surface here. Every read is scoped **server-side from the session**,
// a request naming another partner is refused AND recorded as a security event, document
// expiry is checked **at the action** rather than on a nightly sweep, and nothing a
// supplier submits takes effect on its own — the portal is a door, not an authority.

export * from './portal';
