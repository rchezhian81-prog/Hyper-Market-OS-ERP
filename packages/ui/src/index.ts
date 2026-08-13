// Public surface of @sre/ui — the shared design-system primitives every web-erp screen uses so the eleven
// (soon more) pages look and behave as one product (owner directive item 3; roadmap §19 usability-by-role).
// Three pure, framework-free primitives, all built on the tested `packages/a11y` layer so colour is never
// the only signal:
//   • copy        — bilingual (English/Tamil) text + the reusable "speaks both languages" completeness check
//   • states      — the closed set of screen states (loading/ready/empty/error/pending/locked/recovery)
//   • queue-status — the GST reconciliation queue-category presentation (registered … mismatch)

export * from './copy';
export * from './states';
export * from './queue-status';
