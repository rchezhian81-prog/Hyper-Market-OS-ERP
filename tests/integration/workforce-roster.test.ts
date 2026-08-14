import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-11 M25-FR-01 — roster-gap detection. Given a PROPOSED roster (the shifts a branch must cover, who is
// assigned to each, and the employee list), the route names what is ACTUALLY missing — per role per shift,
// with the hour — through the tested `rosterGaps` engine. A leaver still on the grid is not cover. It is a
// stateless what-if: it stores nothing and only reports. These tests drive the real route over the harness.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const EMPLOYEES = [
  { employeeId: 'u-e1', name: 'Asha', branchId: 'b1', roles: ['opener', 'cashier'], active: true },
  { employeeId: 'u-e2', name: 'Bala', branchId: 'b1', roles: ['cashier'], active: true },
  { employeeId: 'u-gone', name: 'Chandra', branchId: 'b1', roles: ['opener'], active: false }, // a leaver
];

const shift = (requiredRoles: { role: string; count: number }[]) => ({
  shiftId: 's-sun-open', branchId: 'b1', startsAt: '2026-08-16T06:00:00.000Z', endsAt: '2026-08-16T14:00:00.000Z', requiredRoles,
});

const post = (h: ApiHarness, u: string, body: unknown, key = 'k1') =>
  h.request({ method: 'POST', path: '/v1/hr/workforce/roster-gaps', userId: u, tenantId: A, idempotencyKey: key, body });

/** The error code lives at body.error.code (the apiError envelope), never body.code. */
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface GapsBody { gaps: { role: string; assigned: number; short: number; detail: string }[]; gapCount: number; unstaffed: number; shiftsChecked: number }

describe('roster-gap route (M25-FR-01)', () => {
  it('reports no gap when every required role is covered by an active employee', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await post(h, 'u-owner', {
      shifts: [shift([{ role: 'opener', count: 1 }, { role: 'cashier', count: 1 }])],
      assignments: [
        { shiftId: 's-sun-open', employeeId: 'u-e1', role: 'opener' },
        { shiftId: 's-sun-open', employeeId: 'u-e2', role: 'cashier' },
      ],
      employees: EMPLOYEES,
    });
    expect(res.status).toBe(200);
    const body = res.body as GapsBody;
    expect(body.gapCount).toBe(0);
    expect(body.unstaffed).toBe(0);
    expect(body.shiftsChecked).toBe(1);
  });

  it('flags a role nobody is rostered for as unstaffed, named with the hour', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await post(h, 'u-owner', {
      shifts: [shift([{ role: 'opener', count: 1 }])],
      assignments: [], // nobody rostered as opener
      employees: EMPLOYEES,
    });
    expect(res.status).toBe(200);
    const body = res.body as GapsBody;
    expect(body.gapCount).toBe(1);
    expect(body.unstaffed).toBe(1);
    expect(body.gaps[0]?.assigned).toBe(0);
    expect(body.gaps[0]?.detail).toMatch(/NOBODY/);
  });

  it('reports a shift one short (some cover, not enough) — a gap, but not unstaffed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await post(h, 'u-owner', {
      shifts: [shift([{ role: 'cashier', count: 2 }])],
      assignments: [{ shiftId: 's-sun-open', employeeId: 'u-e2', role: 'cashier' }], // 1 of 2
      employees: EMPLOYEES,
    });
    expect(res.status).toBe(200);
    const body = res.body as GapsBody;
    expect(body.gapCount).toBe(1);
    expect(body.unstaffed).toBe(0);
    expect(body.gaps[0]?.assigned).toBe(1);
    expect(body.gaps[0]?.short).toBe(1);
  });

  it('a leaver still on the grid is NOT cover — an inactive employee leaves the role unstaffed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await post(h, 'u-owner', {
      shifts: [shift([{ role: 'opener', count: 1 }])],
      assignments: [{ shiftId: 's-sun-open', employeeId: 'u-gone', role: 'opener' }], // the leaver
      employees: EMPLOYEES,
    });
    expect(res.status).toBe(200);
    const body = res.body as GapsBody;
    expect(body.gapCount).toBe(1);
    expect(body.unstaffed).toBe(1);
  });

  it('refuses a malformed roster (missing arrays / a zero required count)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await post(h, 'u-owner', { assignments: [], employees: EMPLOYEES })).status).toBe(400); // no shifts
    const bad = await post(h, 'u-owner', {
      shifts: [shift([{ role: 'cashier', count: 0 }])], assignments: [], employees: EMPLOYEES, // count must be > 0
    }, 'k2');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_roster');
  });

  it('gates the read on workforce.roster.read — a cashier is refused (default-deny)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const res = await post(h, 'u-cash', {
      shifts: [shift([{ role: 'cashier', count: 1 }])], assignments: [], employees: EMPLOYEES,
    });
    expect(res.status).toBe(403);
  });
});

// API-11 M25-FR-03 — task certification-gating. The gate is on the TASK, never the person: a lapsed
// food-handling certificate blocks the deli counter but not shelf-stacking (`stillAllowed` says so). An
// expired / missing / unverified certificate blocks the task; a needed role the person lacks blocks it; a
// leaver is blocked outright. Stateless — the caller supplies the person + certs; nothing is stored.

const DELI = { employeeId: 'u-d1', name: 'Deepa', branchId: 'b1', roles: ['deli'], active: true };
const cert = (over: Record<string, unknown> = {}) => ({
  certificationId: 'cert-1', employeeId: 'u-d1', kind: 'food-handling', issuedOn: '2025-01-01', validUntil: '2026-12-31', verifiedBy: 'u-mgr', ...over,
});
const gate = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'g1') =>
  h.request({ method: 'POST', path: '/v1/hr/workforce/task-gate', userId: u, tenantId: A, idempotencyKey: key, body });

const base = (over: Record<string, unknown> = {}) => ({
  employee: DELI, task: 'work the deli counter', requiresRole: 'deli', requiresCertification: 'food-handling',
  certifications: [cert()], today: '2026-08-14', ...over,
});

describe('task-gate route (M25-FR-03)', () => {
  it('allows the task when the person is active, in-role, and holds a verified in-date certificate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await gate(h, 'u-owner', base());
    expect(res.status).toBe(200);
    const body = res.body as { allowed: boolean; outcome: string };
    expect(body.allowed).toBe(true);
    expect(body.outcome).toBe('allowed');
  });

  it('blocks the TASK (not the person) on an EXPIRED certificate — and says what they may still do', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await gate(h, 'u-owner', base({ certifications: [cert({ validUntil: '2026-08-01' })] }));
    expect(res.status).toBe(200);
    const body = res.body as { allowed: boolean; outcome: string; stillAllowed?: string };
    expect(body.allowed).toBe(false);
    expect(body.outcome).toBe('certification_expired');
    expect(body.stillAllowed).toBeTruthy(); // the gate is on the task, not the person
  });

  it('treats an UNVERIFIED certificate as none on file (missing), never as cover', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await gate(h, 'u-owner', base({ certifications: [cert({ verifiedBy: undefined })] }));
    expect(res.status).toBe(200);
    expect((res.body as { outcome: string }).outcome).toBe('certification_missing');
  });

  it('blocks a task whose required role the person is not assigned, and a task for a leaver', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const notInRole = await gate(h, 'u-owner', base({ employee: { ...DELI, roles: ['cashier'] } }), 'g2');
    expect((notInRole.body as { outcome: string }).outcome).toBe('not_assigned');
    const leaver = await gate(h, 'u-owner', base({ employee: { ...DELI, active: false } }), 'g3');
    expect((leaver.body as { outcome: string }).outcome).toBe('inactive');
  });

  it('refuses a malformed task gate (no employee / no today)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const bad = await gate(h, 'u-owner', { task: 'x', certifications: [], today: '2026-08-14' }); // no employee
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_task_gate');
  });

  it('gates on workforce.task.read — a cashier is refused (default-deny)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await gate(h, 'u-cash', base())).status).toBe(403);
  });
});

// API-11 M25-FR-02 — checklist assessment. Blocking and non-blocking items are SEPARATED: a blocking item
// outstanding stops the shop; a signed checklist with only non-blocking items left is complete and carries
// them into the handover; an unsigned one is not a record. Stateless — nothing is stored.

const chk = (h: ApiHarness, u: string, body: unknown, key = 'ck1') =>
  h.request({ method: 'POST', path: '/v1/hr/workforce/checklist-assess', userId: u, tenantId: A, idempotencyKey: key, body });
const item = (over: Record<string, unknown> = {}) => ({ itemId: 'i1', description: 'chiller temp', done: false, blocking: true, ...over });

describe('checklist-assess route (M25-FR-02)', () => {
  it('a blocking item outstanding stops the shop (blocked_item), signed or not', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await chk(h, 'u-owner', { checklistId: 'cl-1', kind: 'closing', signedBy: 'u-mgr',
      items: [item({ done: false, blocking: true }), item({ itemId: 'i2', description: 'sweep', done: true, blocking: false })] });
    expect(res.status).toBe(200);
    const body = res.body as { outcome: string; complete: boolean; blockingOutstanding: unknown[] };
    expect(body.outcome).toBe('blocked_item');
    expect(body.complete).toBe(false);
    expect(body.blockingOutstanding).toHaveLength(1);
  });

  it('all done and signed is complete; only non-blocking left and signed is complete-but-carried', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const done = await chk(h, 'u-owner', { checklistId: 'cl-2', kind: 'opening', signedBy: 'u-mgr',
      items: [item({ done: true, blocking: true })] }, 'ck2');
    expect((done.body as { outcome: string }).outcome).toBe('complete');
    const carried = await chk(h, 'u-owner', { checklistId: 'cl-3', kind: 'handover', signedBy: 'u-mgr',
      items: [item({ done: true, blocking: true }), item({ itemId: 'i2', description: 'restock bags', done: false, blocking: false })] }, 'ck3');
    const body = carried.body as { outcome: string; complete: boolean };
    expect(body.outcome).toBe('incomplete');
    expect(body.complete).toBe(true); // carried into the handover, not a blocker
  });

  it('a checklist with nobody’s name on it is a list, not a record (not_signed)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await chk(h, 'u-owner', { checklistId: 'cl-4', kind: 'closing', items: [item({ done: true, blocking: true })] }, 'ck4');
    expect((res.body as { outcome: string }).outcome).toBe('not_signed');
  });

  it('refuses a malformed checklist and gates on workforce.checklist.read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const bad = await chk(h, 'u-owner', { checklistId: 'cl-5', kind: 'nope', items: [] }, 'ck5');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_checklist');
    expect((await chk(h, 'u-cash', { checklistId: 'cl-6', kind: 'closing', items: [item({ done: true })], signedBy: 'x' }, 'ck6')).status).toBe(403);
  });
});

// API-11 M25-FR-03 — exact incentive (§29.1). A missed target pays NOTHING, not a proportion.

const inc = (h: ApiHarness, u: string, body: unknown, key = 'in1') =>
  h.request({ method: 'POST', path: '/v1/hr/workforce/incentive', userId: u, tenantId: A, idempotencyKey: key, body });

describe('incentive route (M25-FR-03)', () => {
  it('pays the exact payout when the target is met, and nothing when it is missed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const met = await inc(h, 'u-owner', { employeeId: 'u-e1', metric: 'upt', targetMinor: 100_000, achievedMinor: 100_000, payoutMinor: 5_000 });
    expect((met.body as { met: boolean; payoutMinor: number }).met).toBe(true);
    expect((met.body as { payoutMinor: number }).payoutMinor).toBe(5_000);
    const missed = await inc(h, 'u-owner', { employeeId: 'u-e1', metric: 'upt', targetMinor: 100_000, achievedMinor: 90_000, payoutMinor: 5_000 }, 'in2');
    expect((missed.body as { met: boolean; payoutMinor: number }).met).toBe(false);
    expect((missed.body as { payoutMinor: number }).payoutMinor).toBe(0); // "nearly" is a conversation, not a formula
  });

  it('applies an accelerator on the excess and honours the cap', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // excess 100_000 × 100bps = 1_000 accelerator on top of 5_000 = 6_000 raw, capped at 5_500.
    const res = await inc(h, 'u-owner', { employeeId: 'u-e1', metric: 'sales', targetMinor: 100_000, achievedMinor: 200_000, payoutMinor: 5_000, acceleratorBps: 100, capMinor: 5_500 }, 'in3');
    expect((res.body as { payoutMinor: number }).payoutMinor).toBe(5_500);
  });

  it('refuses a malformed incentive and gates on workforce.incentive.read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const bad = await inc(h, 'u-owner', { employeeId: 'u-e1', metric: 'upt', targetMinor: 100_000 }, 'in4'); // no achievedMinor/payoutMinor
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_an_incentive');
    expect((await inc(h, 'u-cash', { employeeId: 'u-e1', metric: 'upt', targetMinor: 1, achievedMinor: 1, payoutMinor: 1 }, 'in5')).status).toBe(403);
  });
});

// API-11 M25-FR-04 — SOP acknowledgement. Acknowledging v3 is not acknowledging v5.

const sop = (h: ApiHarness, u: string, body: unknown, key = 'sp1') =>
  h.request({ method: 'POST', path: '/v1/hr/workforce/sop-status', userId: u, tenantId: A, idempotencyKey: key, body });
const CASHIER_EMP = { employeeId: 'u-c1', name: 'Eswari', branchId: 'b1', roles: ['cashier'], active: true };
const TILL_SOP = { sopId: 'sop-till', title: 'Till procedure', version: 5, forRoles: ['cashier'] };
const ack = (over: Record<string, unknown> = {}) => ({ sopId: 'sop-till', version: 5, employeeId: 'u-c1', acknowledgedAt: '2026-08-01T09:00:00.000Z', ...over });

describe('sop-status route (M25-FR-04)', () => {
  it('flags an OLD acknowledgement as not up to date (v3 signed, v5 current)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await sop(h, 'u-owner', { employee: CASHIER_EMP, sops: [TILL_SOP], acknowledgements: [ack({ version: 3 })] });
    expect(res.status).toBe(200);
    const body = res.body as { statuses: { upToDate: boolean }[]; outstanding: number; count: number };
    expect(body.count).toBe(1);
    expect(body.statuses[0]?.upToDate).toBe(false);
    expect(body.outstanding).toBe(1);
  });

  it('is up to date when the current version is acknowledged, and excludes SOPs for other roles', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const current = await sop(h, 'u-owner', { employee: CASHIER_EMP, sops: [TILL_SOP], acknowledgements: [ack()] }, 'sp2');
    expect((current.body as { outstanding: number }).outstanding).toBe(0);
    // A manager-only SOP is not this cashier's concern — it is filtered out.
    const other = await sop(h, 'u-owner', { employee: CASHIER_EMP, sops: [{ sopId: 'sop-mgr', title: 'Cash office', version: 2, forRoles: ['manager'] }], acknowledgements: [] }, 'sp3');
    expect((other.body as { count: number }).count).toBe(0);
  });

  it('refuses a malformed SOP status check and gates on workforce.sop.read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const bad = await sop(h, 'u-owner', { employee: CASHIER_EMP, sops: [{ sopId: 'x', title: 'y' }], acknowledgements: [] }, 'sp4'); // sop missing version/forRoles
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_sop_status');
    expect((await sop(h, 'u-cash', { employee: CASHIER_EMP, sops: [TILL_SOP], acknowledgements: [ack()] }, 'sp5')).status).toBe(403);
  });
});
