// Public surface of @sre/notifications — consent-safe notification routing
// (M31-FR-03: a breaching send is blocked) and a retry/dead-letter delivery queue
// (M31-FR-04: poison sends visible, never dropped). Grows one reviewed, tested unit
// at a time.

export * from './guard';
export * from './queue';
