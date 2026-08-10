// Public surface of @sre/facilities — M26.
//
// The physical store: assets with warranty/AMC/service and downtime measured from when it
// broke (FR-01, FR-04); cold rooms and power watched as EQUIPMENT so a breach names the
// stock it exposes and a silent probe is a fault rather than a pass (FR-02); cleaning, pest,
// fire and safety schedules where a compliance-linked miss escalates by itself and a tick
// without evidence is refused (FR-03); incidents that cannot be closed without a corrective
// action, and an evidence pack that says plainly whether it would survive an inspection.
//
// A per-tenant optional feature (ADR-0003). Cold-chain findings feed M10 quality holds.

export * from './assets';
export * from './monitoring';
export * from './schedules';
export * from './weighing-verification';
