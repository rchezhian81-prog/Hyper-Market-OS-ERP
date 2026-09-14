import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// HR/Workforce DURABLE certification store (M25-FR-03 follow-on) on the live API. The POST /task-gate route is
// a stateless what-if; this persists the certificates (append-only, latest-per-id, hard rule #2) so the
// stateful GET /v1/hr/workforce/employees/:id/task-gate reads a STORED employee (from the roster store) + their
// certificate on file and runs the tested canPerformTask. The gate is on the TASK, never the person: a lapsed
// certificate blocks the deli counter, not shelf-stacking. A leaver is blocked outright; an unverified
// certificate is not cover. Writes gated workforce.roster.manage; the task-gate read workforce.task.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const putEmployee = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/employees/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const putCert = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/certifications/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const listCerts = (h: ApiHarness, u: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/certifications', userId: u, tenantId: A, query });
const taskGate = (h: ApiHarness, u: string, employeeId: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: `/v1/hr/workforce/employees/${employeeId}/task-gate`, userId: u, tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Decision { readonly allowed: boolean; readonly outcome: string; readonly stillAllowed?: string }
const decisionOf = (res: { body: unknown }): Decision => (res.body as { decision: Decision }).decision;

const emp = (over: Record<string, unknown> = {}) => ({ name: 'Ravi', branchId: 'b1', roles: ['deli'], active: true, ...over });
const cert = (over: Record<string, unknown> = {}) =>
  ({ employeeId: 'E1', kind: 'food-handling', issuedOn: '2026-01-01', validUntil: '2026-12-31', verifiedBy: 'u-mgr', ...over });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // workforce.roster.manage + read + task.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // none of them
  return h;
}

describe('durable certification store (M25-FR-03 follow-on)', () => {
  it('gates a task on the stored certificate: allowed while valid, blocked once expired — the TASK, not the person', async () => {
    const h = await cast();
    expect((await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1')).status).toBe(200);
    expect((await putCert(h, 'u-mgr', 'C1', cert(), 'k2')).status).toBe(200);

    // While the certificate is valid, the deli task is allowed.
    const ok = decisionOf(await taskGate(h, 'u-mgr', 'E1', { task: 'deli-counter', requiresCertification: 'food-handling', requiresRole: 'deli', today: '2026-09-14' }));
    expect(ok).toMatchObject({ allowed: true, outcome: 'allowed' });

    // After it expires, the TASK is blocked — but the person may still do anything not certification-gated.
    const expired = decisionOf(await taskGate(h, 'u-mgr', 'E1', { task: 'deli-counter', requiresCertification: 'food-handling', today: '2027-01-01' }));
    expect(expired.allowed).toBe(false);
    expect(expired.outcome).toBe('certification_expired');
    expect(expired.stillAllowed).toBeTruthy();

    // The stored certificate reads back.
    const list = (await listCerts(h, 'u-mgr', { employeeId: 'E1' })).body as { count: number };
    expect(list.count).toBe(1);
  });

  it('an unverified certificate is not cover, and a role the person lacks blocks the task', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1');
    // A forklift certificate with nobody's verification on it → not cover.
    await putCert(h, 'u-mgr', 'C-unverified', cert({ certificationId: 'C-unverified', kind: 'forklift', verifiedBy: undefined }), 'k2');
    const missing = decisionOf(await taskGate(h, 'u-mgr', 'E1', { task: 'forklift', requiresCertification: 'forklift', today: '2026-09-14' }));
    expect(missing.outcome).toBe('certification_missing');

    // A role the person is not assigned blocks the task (not the person).
    const notAssigned = decisionOf(await taskGate(h, 'u-mgr', 'E1', { task: 'close-the-till', requiresRole: 'manager', today: '2026-09-14' }));
    expect(notAssigned).toMatchObject({ allowed: false, outcome: 'not_assigned' });
  });

  it('a leaver is blocked outright', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp({ active: false }), 'k1');
    const decision = decisionOf(await taskGate(h, 'u-mgr', 'E1', { task: 'anything', today: '2026-09-14' }));
    expect(decision).toMatchObject({ allowed: false, outcome: 'inactive' });
  });

  it('404s for an unknown employee, gates writes/reads, and refuses a malformed certificate', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1');
    // A decision cannot be made about somebody the shop has no record of.
    expect((await taskGate(h, 'u-mgr', 'GHOST', { task: 'x' })).status).toBe(404);
    // A cashier can neither record a certificate nor read the gate.
    expect((await putCert(h, 'u-cash', 'C1', cert(), 'k2')).status).toBe(403);
    expect((await taskGate(h, 'u-cash', 'E1', { task: 'deli-counter' })).status).toBe(403);
    // A malformed certificate is refused, nothing stored.
    expect(codeOf(await putCert(h, 'u-mgr', 'C-bad', { employeeId: 'E1', issuedOn: '2026-01-01', validUntil: '2026-12-31' }, 'k3'))).toBe('not_readable_as_a_certification');
  });
});
