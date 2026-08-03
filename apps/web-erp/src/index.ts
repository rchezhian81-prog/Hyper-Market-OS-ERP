// Public surface of the web ERP shell (§27 role surfaces / M02) — the
// framework-agnostic application model: role-scoped navigation derived from real
// permissions, and the approvals workbench that makes separation of duties visible
// on screen. Pure and deterministic, so any SSR view can render it.

export * from './navigation';
export * from './approvals-workbench';
