import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// HR/Workforce DURABLE SOP-acknowledgement store (M25-FR-04 follow-on) on the live API. The POST /sop-status
// route is a stateless what-if; this persists the SOPs and the acknowledgements (append-only, latest-per-id,
// hard rule #2) so GET /v1/hr/workforce/employees/:id/sop-status reads a STORED employee + the SOPs for their
// role + their acknowledgements and runs the tested sopStatus. Acknowledging v3 is not acknowledging v5 — an
// old signature that looks like compliance is worse than none. Writes gated workforce.roster.manage; reads
// workforce.sop.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const putEmployee = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/employees/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const putSop = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/sops/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const ackSop = (h: ApiHarness, u: string, sopId: string, employeeId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/sops/${sopId}/acknowledgements/${employeeId}`, userId: u, tenantId: A, idempotencyKey: key, body });
const sopStatusFor = (h: ApiHarness, u: string, employeeId: string) =>
  h.request({ method: 'GET', path: `/v1/hr/workforce/employees/${employeeId}/sop-status`, userId: u, tenantId: A });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Status { readonly sopId: string; readonly currentVersion: number; readonly acknowledgedVersion?: number; readonly upToDate: boolean }
interface StatusBody { readonly statuses: readonly Status[]; readonly count: number; readonly outstanding: number }
const bodyOf = (res: { body: unknown }): StatusBody => res.body as StatusBody;

const emp = (over: Record<string, unknown> = {}) => ({ name: 'Meena', branchId: 'b1', roles: ['deli'], active: true, ...over });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // workforce.roster.manage + sop.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('durable SOP-acknowledgement store (M25-FR-04 follow-on)', () => {
  it('an SOP for the person\'s role is outstanding until acknowledged at its CURRENT version — v3 is not v5', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1');
    // Publish a deli SOP at v5.
    expect((await putSop(h, 'u-mgr', 'S-hygiene', { title: 'Deli hygiene', version: 5, forRoles: ['deli'] }, 'k2')).status).toBe(200);

    // Never acknowledged → outstanding.
    let body = bodyOf(await sopStatusFor(h, 'u-mgr', 'E1'));
    expect(body.count).toBe(1);
    expect(body.outstanding).toBe(1);

    // Acknowledging an OLD version (3) is not current → still outstanding.
    expect((await ackSop(h, 'u-mgr', 'S-hygiene', 'E1', { version: 3 }, 'k3')).status).toBe(200);
    body = bodyOf(await sopStatusFor(h, 'u-mgr', 'E1'));
    expect(body.outstanding).toBe(1);
    expect(body.statuses[0]).toMatchObject({ currentVersion: 5, acknowledgedVersion: 3, upToDate: false });

    // Acknowledging the current version (5) → up to date.
    expect((await ackSop(h, 'u-mgr', 'S-hygiene', 'E1', { version: 5 }, 'k4')).status).toBe(200);
    body = bodyOf(await sopStatusFor(h, 'u-mgr', 'E1'));
    expect(body.outstanding).toBe(0);
    expect(body.statuses[0]).toMatchObject({ currentVersion: 5, acknowledgedVersion: 5, upToDate: true });
  });

  it('an SOP for a different role does not apply to this person, and it all survives a restart', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp({ roles: ['deli'] }), 'k1');
    await putSop(h, 'u-mgr', 'S-forklift', { title: 'Forklift safety', version: 1, forRoles: ['warehouse'] }, 'k2'); // not deli
    await putSop(h, 'u-mgr', 'S-hygiene', { title: 'Deli hygiene', version: 1, forRoles: ['deli'] }, 'k3');
    await ackSop(h, 'u-mgr', 'S-hygiene', 'E1', { version: 1 }, 'k4');

    // Only the deli SOP applies; it is acknowledged → nothing outstanding.
    const restarted = apiHarness({ store: h.store });
    const body = bodyOf(await sopStatusFor(restarted, 'u-owner', 'E1'));
    expect(body.count).toBe(1); // the warehouse SOP does not apply to a deli worker
    expect(body.statuses[0]!.sopId).toBe('S-hygiene');
    expect(body.outstanding).toBe(0);
  });

  it('404s for an unknown employee, gates writes/reads, and refuses a malformed SOP', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1');
    expect((await sopStatusFor(h, 'u-mgr', 'GHOST')).status).toBe(404);
    // A cashier can neither publish an SOP nor read the status.
    expect((await putSop(h, 'u-cash', 'S1', { title: 'x', version: 1, forRoles: ['deli'] }, 'k2')).status).toBe(403);
    expect((await sopStatusFor(h, 'u-cash', 'E1')).status).toBe(403);
    // A malformed SOP is refused, nothing stored.
    expect(codeOf(await putSop(h, 'u-mgr', 'S-bad', { title: 'no version', forRoles: ['deli'] }, 'k3'))).toBe('not_readable_as_a_sop');
  });
});
