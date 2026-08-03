// Public surface of @sre/identity — named accounts and session policy (M02-FR-01),
// and the joiner/mover/leaver access lifecycle with time-bound emergency access
// (M02-FR-04). Holds no credentials by design: a password that never enters this
// codebase can never be logged by it (hard rule #4).

export * from './account';
export * from './lifecycle';
