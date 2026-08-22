import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Service-desk compensation, end to end (M21-FR-03 · §28, API-06). Money leaving the business, decided by
// the person the customer is currently shouting at — which is why the reason, the authority limit and the
// second signature are not optional. A reason is mandatory even within authority ("goodwill" explains
// nothing three months later); above the agent's authority a SEPARATE approver is required and the agent
// cannot approve their own grant; an absolute policy cap is a management decision, not a desk one.
// Append-only (a compensation ledger). Gated service.case.manage to grant, service.case.read to list.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASE = { kind: 'complaint', customerRef: 'c1', priority: 'normal', summary: 'wrong item delivered', assignedTo: 'u-agent' };

const open = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}`, userId: u, tenantId: A, idempotencyKey: `open-${id}`, body: CASE });
const comp = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}/compensation`, userId: u, tenantId: A, idempotencyKey: key, body });
const comps = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/service/cases/${id}/compensations`, userId: u, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // service.case.manage + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('service-desk compensation is a §28 financial control (M21-FR-03)', () => {
  it('grants within authority with a reason, and records it on the case ledger', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1');
    const res = await comp(h, 'u-mgr', 'k1', { kind: 'goodwill_credit', amountMinor: 500, reason: 'damaged on arrival, replacement out of stock', agentAuthorityMinor: 1000 }, 'c-k1-1');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ granted: true, outcome: 'granted', amountMinor: 500 });

    const list = (await comps(h, 'u-owner', 'k1')).body as { count: number; totalMinor: number; compensations: { grantedBy: string; reason: string }[] };
    expect(list).toMatchObject({ count: 1, totalMinor: 500 });
    expect(list.compensations[0]).toMatchObject({ grantedBy: 'u-mgr' });
  });

  it('needs a separate approver above authority, refuses self-approval, and grants with a valid one', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1');

    // Above the agent's own authority — a separate approver is required (§28).
    expect(codeOf(await comp(h, 'u-mgr', 'k1', { kind: 'refund', amountMinor: 5000, reason: 'repeated failures', agentAuthorityMinor: 1000 }, 'c-a'))).toBe('needs_approval');
    // The agent cannot be the approver of their own grant.
    expect(codeOf(await comp(h, 'u-mgr', 'k1', { kind: 'refund', amountMinor: 5000, reason: 'repeated failures', agentAuthorityMinor: 1000, approval: { subjectRef: 'k1', status: 'approved', decidedBy: 'u-mgr', reason: 'ok' } }, 'c-b'))).toBe('self_approved');
    // An approval for a DIFFERENT case does not authorise this one.
    expect(codeOf(await comp(h, 'u-mgr', 'k1', { kind: 'refund', amountMinor: 5000, reason: 'repeated failures', agentAuthorityMinor: 1000, approval: { subjectRef: 'other', status: 'approved', decidedBy: 'u-boss', reason: 'ok' } }, 'c-c'))).toBe('needs_approval');

    // A real second signature, from a different person, on this case — granted.
    const ok = await comp(h, 'u-mgr', 'k1', { kind: 'refund', amountMinor: 5000, reason: 'repeated failures', agentAuthorityMinor: 1000, approval: { subjectRef: 'k1', status: 'approved', decidedBy: 'u-boss', reason: 'signed off' } }, 'c-d');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ granted: true, approvedBy: 'u-boss' });
  });

  it('a reason is mandatory, and the policy cap is absolute', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1');
    // No reason — refused even within authority.
    expect(codeOf(await comp(h, 'u-mgr', 'k1', { kind: 'goodwill_credit', amountMinor: 100, reason: '   ', agentAuthorityMinor: 1000 }, 'c-nr'))).toBe('no_reason');
    // Above the tenant ceiling — a management decision, refused even with a valid approver.
    expect(codeOf(await comp(h, 'u-mgr', 'k1', { kind: 'refund', amountMinor: 100000, reason: 'x', agentAuthorityMinor: 1000, policyCapMinor: 50000, approval: { subjectRef: 'k1', status: 'approved', decidedBy: 'u-boss', reason: 'ok' } }, 'c-cap'))).toBe('exceeds_policy_cap');
  });

  it('is gated, 404s an unknown case, and the grant survives a restart', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1');
    expect((await comp(h, 'u-cash', 'k1', { kind: 'refund', amountMinor: 100, reason: 'x', agentAuthorityMinor: 1000 }, 'c-cash')).status).toBe(403);
    expect((await comp(h, 'u-mgr', 'ghost', { kind: 'refund', amountMinor: 100, reason: 'x', agentAuthorityMinor: 1000 }, 'c-ghost')).status).toBe(404);

    await comp(h, 'u-mgr', 'k1', { kind: 'goodwill_credit', amountMinor: 250, reason: 'sorry for the wait', agentAuthorityMinor: 1000 }, 'c-persist');
    const restarted = apiHarness({ store: h.store });
    expect(((await comps(restarted, 'u-owner', 'k1')).body as { count: number; totalMinor: number })).toMatchObject({ count: 1, totalMinor: 250 });
  });
});
