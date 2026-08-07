// Public surface of @sre/import — template-driven import (M30-FR-01/03/04): a
// proper delimited-file parser, and the validate → preview → approve → commit
// pipeline where nothing changes until a human has seen exactly what would change.
// Carries the store's #1 daily pain (audit A-03: the 80+ line supplier invoice).
//
// Plus job history and data-quality scoring (M30-FR-04): every job is recorded whether it
// succeeded or not, because a history of only the successes is how a file that fails half the
// time looks perfect. The score belongs to the SOURCE rather than the operator — a supplier
// whose file has had 12% of rows rejected every week for a year is not an operator problem,
// and it is invisible because the operator has been fixing it by hand and the import has been
// succeeding. Rejection REASONS are ranked with what to do about each, and the quiet cost is
// stated in hours a year, because "12% rejected" sounds tolerable and "52 hours a year
// retyping their rows" does not.

export * from './delimited';
export * from './import-job';
export * from './job-history';
