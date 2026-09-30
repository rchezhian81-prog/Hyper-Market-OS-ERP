// Public surface of @sre/sync — the offline-first sync primitives (P-01, §31).
// Starts with the durable outbox (idempotent enqueue, visible unsent count,
// dead-letter that is never dropped). Grows one reviewed, tested unit at a time.

export * from './outbox';
export * from './device-outbox';
// The shared device → store-computer contract and drain (SP-2a): what a screen or handheld may hand to
// the box, how the box answers per item, and the five states a person sees for each piece of work.
export * from './device-relay';
export * from './device-drain';
