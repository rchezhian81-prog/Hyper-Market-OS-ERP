// Public surface of @sre/documents — versioned templates and immutable issued
// documents (M31-FR-01).
//
// The rule the whole package exists for: **a template change is a new version, never an
// overwrite of documents already issued.** An issued document stores its rendered
// content and the exact version it came from, so July's invoice still shows July's
// address after the template changes in August — and a template version any document
// depends on can never be removed (hard rule #6).

export * from './templates';
