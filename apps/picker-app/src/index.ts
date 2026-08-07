// Public surface of the picker/packer app (M19 / M18 / D09) — the handheld session:
// scan bin → scan item → confirm, customer-confirmed substitutions, weighed final
// price at pick, quality checks, and a dispatch manifest derived from what was
// actually packed. Synchronous and local, so it works with no signal.

export * from './pick-session';
