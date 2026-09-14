import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// HR/Workforce DURABLE roster store (M25-FR-01 follow-on) on the live API. The workforce decision routes are
// stateless what-ifs; this persists the staff directory, shifts and assignments (append-only, latest-per-id,
// hard rule #2) so GET /v1/hr/workforce/roster-gaps reports what the STORED roster is missing — the stateful
// counterpart to the POST what-if — and it survives a restart. A leaver still on the grid is not cover; a
// shift with nobody rostered for a required role is the unstaffed-critical exception. Writes are gated
// workforce.roster.manage (a manager within scope, §28/P-04); reads workforce.roster.read; a cashier holds neither.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const putEmployee = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/employees/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const putShift = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/shifts/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const assign = (h: ApiHarness, u: string, shiftId: string, employeeId: string, role: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/shifts/${shiftId}/assignments/${employeeId}`, userId: u, tenantId: A, idempotencyKey: key, body: { role } });
const rosterGaps = (h: ApiHarness, u: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/roster-gaps', userId: u, tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Gap { readonly shiftId: string; readonly role: string; readonly needed: number; readonly assigned: number; readonly short: number }
interface GapsBody { readonly gaps: readonly Gap[]; readonly gapCount: number; readonly unstaffed: number; readonly shiftsChecked: number }

const emp = (over: Record<string, unknown> = {}) => ({ name: 'Asha', branchId: 'b1', roles: ['cashier'], active: true, ...over });
const shift = (over: Record<string, unknown> = {}) =>
  ({ branchId: 'b1', startsAt: '2026-09-20T06:00:00Z', endsAt: '2026-09-20T14:00:00Z', requiredRoles: [{ role: 'cashier', count: 2 }, { role: 'manager', count: 1 }], ...over });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // workforce.roster.manage + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('durable roster store (M25-FR-01 follow-on)', () => {
  it('records the roster and reports what it is missing — per role per shift, worst-first — surviving a restart', async () => {
    const h = await cast();
    expect((await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1')).status).toBe(200);
    expect((await putShift(h, 'u-mgr', 'S1', shift(), 'k2')).status).toBe(200);
    // Only one cashier rostered (of 2 needed); nobody as manager.
    expect((await assign(h, 'u-mgr', 'S1', 'E1', 'cashier', 'k3')).status).toBe(200);

    const body = (await rosterGaps(h, 'u-mgr')).body as GapsBody;
    // cashier: 1 of 2 → short 1; manager: 0 of 1 → short 1 and unstaffed.
    expect(body.gapCount).toBe(2);
    expect(body.unstaffed).toBe(1); // the manager role has NOBODY rostered
    expect(body.shiftsChecked).toBe(1);
    const cashier = body.gaps.find((g) => g.role === 'cashier');
    const manager = body.gaps.find((g) => g.role === 'manager');
    expect(cashier).toMatchObject({ needed: 2, assigned: 1, short: 1 });
    expect(manager).toMatchObject({ needed: 1, assigned: 0, short: 1 });

    // Durable: a restart rebuilds the roster from the event log.
    const restarted = apiHarness({ store: h.store });
    const after = (await rosterGaps(restarted, 'u-owner')).body as GapsBody;
    expect(after.gapCount).toBe(2);
    expect(after.unstaffed).toBe(1);
  });

  it('a leaver still on the grid is not cover — marking an assigned employee inactive re-opens the gap', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1');
    // A shift needing exactly one cashier, and E1 covers it → no gap.
    await putShift(h, 'u-mgr', 'S1', shift({ requiredRoles: [{ role: 'cashier', count: 1 }] }), 'k2');
    await assign(h, 'u-mgr', 'S1', 'E1', 'cashier', 'k3');
    expect(((await rosterGaps(h, 'u-mgr')).body as GapsBody).gapCount).toBe(0);

    // E1 leaves — recorded active:false (kept, never deleted). The name is still on the shift but is not cover.
    expect((await putEmployee(h, 'u-mgr', 'E1', emp({ active: false }), 'k4')).status).toBe(200);
    const body = (await rosterGaps(h, 'u-mgr')).body as GapsBody;
    expect(body.gapCount).toBe(1);
    expect(body.unstaffed).toBe(1); // nobody active covers it now
  });

  it('narrows to one branch on request', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1');
    await putShift(h, 'u-mgr', 'S1', shift(), 'k2');                                  // branch b1
    await putShift(h, 'u-mgr', 'S2', shift({ branchId: 'b2' }), 'k3');                // branch b2
    expect(((await rosterGaps(h, 'u-mgr', { branchId: 'b1' })).body as GapsBody).shiftsChecked).toBe(1);
    expect(((await rosterGaps(h, 'u-mgr')).body as GapsBody).shiftsChecked).toBe(2); // both branches
  });

  it('gates writes on workforce.roster.manage and reads on workforce.roster.read; refuses a malformed body', async () => {
    const h = await cast();
    // A cashier can neither write the roster nor read its gaps.
    expect((await putEmployee(h, 'u-cash', 'E1', emp(), 'k1')).status).toBe(403);
    expect((await rosterGaps(h, 'u-cash')).status).toBe(403);
    // A malformed staff record is refused, nothing stored.
    expect(codeOf(await putEmployee(h, 'u-mgr', 'E1', { branchId: 'b1', roles: ['cashier'], active: true }, 'k2'))).toBe('not_readable_as_an_employee');
    expect(codeOf(await putShift(h, 'u-mgr', 'S1', { branchId: 'b1', startsAt: 'x', endsAt: 'y', requiredRoles: [{ role: 'cashier', count: 0 }] }, 'k3'))).toBe('not_readable_as_a_shift');
  });
});
