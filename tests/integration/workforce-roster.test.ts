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
