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
