// Public surface of @sre/config — versioned configuration with one-step rollback
// (M01-FR-03): every change is a new immutable version; rollback restores a prior
// value as a new version (append-only). Grows one reviewed, tested unit at a time.

export * from './config';
