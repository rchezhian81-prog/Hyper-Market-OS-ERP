import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId, sentWithApproval } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

// Service-desk compensation, end to end (M21-FR-03 · §28, API-06). Money leaving the business, decided by
// the person the customer is currently shouting at — which is why the reason and the second signature are
// not optional. Two §28 controls that used to be dodgeable are now real:
//   1. The authority LIMITS are the tenant's policy, sourced server-side — the caller can no longer send
//      their own `agentAuthorityMinor` in the body and grant any amount "within their own authority".
//   2. An over-limit grant needs an approval given IN THEIR OWN SESSION by someone who genuinely holds
//      `service.compensation.approve` (the owner) — head office's maker-checker engine (ADR-0024). A name typed into
//      the request is refused by name (audit PA-03); before 2b-vi-b-3 a typed name with the authority was enough.
// The desk default is ₹500 an agent may grant alone; ₹5,000 is the absolute desk ceiling; the owner may
// set both. Append-only (a compensation ledger). Gated service.case.manage to grant, service.case.read to read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASE = { kind: 'complaint', customerRef: 'c1', priority: 'normal', summary: 'wrong item delivered', assignedTo: 'u-agent' };

const open = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}`, userId: u, tenantId: A, idempotencyKey: `open-${id}`, body: CASE });
const comp = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}/compensation`, userId: u, tenantId: A, idempotencyKey: key, body });
/** The grant as two people make it: the agent asks for exactly this grant; `checker` approves it in their own session;
 *  the grant names the approval. When the checker may not approve (the agent, no authority), the engine's refusal returns. */
const approvedComp = (h: ApiHarness, u: string, checker: string, id: string, body: Record<string, unknown>, key: string) =>
  sentWithApproval(h, A, u, checker, { kind: 'service_compensation', subjectRef: id, pathIds: { caseId: id }, valueMinor: body['amountMinor'] as number },
    body, (b) => comp(h, u, id, b, key));
const comps = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/service/cases/${id}/compensations`, userId: u, tenantId: A });
const getPolicy = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/service/compensation-policy', userId: u, tenantId: A });
const setPolicy = (h: ApiHarness, u: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/service/compensation-policy', userId: u, tenantId: A, idempotencyKey: key, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// ₹ in paise (minor). Defaults: agent may grant up to ₹500 (50_000) alone; desk ceiling ₹5,000 (500_000).
async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // owner — holds service.compensation.approve
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // service.case.manage, but NOT compensation-approve
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('service-desk compensation is a §28 financial control (M21-FR-03)', () => {
  it('grants within the desk authority with a reason, and records it on the case ledger', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1');
    // ₹300 — under the ₹500 desk-agent authority, so granted alone.
    const res = await comp(h, 'u-mgr', 'k1', { kind: 'goodwill_credit', amountMinor: 30_000, reason: 'damaged on arrival, replacement out of stock' }, 'c-k1-1');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ granted: true, outcome: 'granted', amountMinor: 30_000 });

    const list = (await comps(h, 'u-owner', 'k1')).body as { count: number; totalMinor: number; compensations: { grantedBy: string }[] };
    expect(list).toMatchObject({ count: 1, totalMinor: 30_000 });
    expect(list.compensations[0]).toMatchObject({ grantedBy: 'u-mgr' });
  });

  it('above the desk authority, needs an approval GIVEN by someone who holds the authority — a name is not an approval', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1');
    const OVER = { kind: 'refund', amountMinor: 200_000, reason: 'repeated failures' };

    // ₹2,000 — above the ₹500 desk authority, a separate approver is required (§28).
    expect(codeOf(await comp(h, 'u-mgr', 'k1', OVER, 'c-a'))).toBe('needs_approval');
    // Nobody approves their own grant — the engine refuses the decision: the agent (who lacks the authority anyway), and
    // even the owner, who holds it.
    expect(codeOf(await approvedComp(h, 'u-mgr', 'u-mgr', 'k1', OVER, 'c-b'))).toBe('not_permitted_for_this_approval');
    expect(codeOf(await approvedComp(h, 'u-owner', 'u-owner', 'k1', OVER, 'c-b2'))).toBe('self_approval');
    // An approval for a DIFFERENT case does not authorise this one.
    const forOther = await approvedRequestId(h, A, 'u-mgr', 'u-owner', { kind: 'service_compensation', subjectRef: 'other', details: actionDetails(OVER, { caseId: 'other' }), valueMinor: 200_000 });
    expect(codeOf(await comp(h, 'u-mgr', 'k1', { ...OVER, approvalId: forOther }, 'c-c'))).toBe('approval_does_not_match');
    // Someone who does NOT hold service.compensation.approve cannot approve one (an unprovisioned 'u-boss', a cashier).
    expect((await approvedComp(h, 'u-mgr', 'u-boss', 'k1', OVER, 'c-noauth')).status).toBe(403);
    expect((await approvedComp(h, 'u-mgr', 'u-cash', 'k1', OVER, 'c-noauth2')).status).toBe(403);
    // THE BYPASS, CLOSED (audit PA-03): the owner's name typed into the request is refused by name — before, it granted.
    expect(codeOf(await comp(h, 'u-mgr', 'k1', { ...OVER, approval: { subjectRef: 'k1', status: 'approved', decidedBy: 'u-owner', reason: 'signed off' } }, 'c-typed'))).toBe('approver_named_without_approval');
    expect(((await comps(h, 'u-owner', 'k1')).body as { count: number }).count).toBe(0); // nothing was paid

    // The OWNER approves this grant in their own session — granted, and the approval is used up.
    const ok = await approvedComp(h, 'u-mgr', 'u-owner', 'k1', OVER, 'c-ok');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ granted: true, approvedBy: 'u-owner' });
  });

  it('a reason is mandatory, and the desk ceiling is absolute — even with a valid approver', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1');
    // No reason — refused even within authority.
    expect(codeOf(await comp(h, 'u-mgr', 'k1', { kind: 'goodwill_credit', amountMinor: 30_000, reason: '   ' }, 'c-nr'))).toBe('no_reason');
    // ₹6,000 — above the ₹5,000 desk ceiling: a management decision, refused even with a valid owner approval.
    expect(codeOf(await approvedComp(h, 'u-mgr', 'u-owner', 'k1', { kind: 'refund', amountMinor: 600_000, reason: 'x' }, 'c-cap'))).toBe('exceeds_policy_cap');
  });

  it('the owner may grant up to the desk ceiling alone, but never above it', async () => {
    const h = await cast();
    await open(h, 'u-owner', 'k1');
    // The owner's own authority is the desk ceiling (₹5,000) — granted alone, no approval needed.
    const atCeiling = await comp(h, 'u-owner', 'k1', { kind: 'refund', amountMinor: 500_000, reason: 'long-standing customer, faulty appliance' }, 'c-owner-ceil');
    expect(atCeiling.status).toBe(201);
    expect(atCeiling.body).toMatchObject({ granted: true, outcome: 'granted' });
    expect((atCeiling.body as { approvedBy?: string }).approvedBy).toBeUndefined(); // within own authority
    // Above the ceiling — refused even for the owner (not a desk decision).
    expect(codeOf(await comp(h, 'u-owner', 'k1', { kind: 'refund', amountMinor: 600_000, reason: 'x' }, 'c-owner-over'))).toBe('exceeds_policy_cap');
  });

  it('the limits are the tenant policy — readable, owner-settable, and never the caller\'s to declare', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1');

    // The default policy is readable (by a manager) and marked as the software default.
    expect((await getPolicy(h, 'u-mgr')).body).toMatchObject({ agentAuthorityMinor: 50_000, deskCeilingMinor: 500_000, isDefault: true });

    // Only the owner may set the limits.
    expect((await setPolicy(h, 'u-mgr', { agentAuthorityMinor: 100_000, deskCeilingMinor: 1_000_000 }, 's-mgr')).status).toBe(403);
    expect((await setPolicy(h, 'u-cash', { agentAuthorityMinor: 100_000, deskCeilingMinor: 1_000_000 }, 's-cash')).status).toBe(403);
    // An agent authority above the ceiling is not a policy.
    expect((await setPolicy(h, 'u-owner', { agentAuthorityMinor: 2_000_000, deskCeilingMinor: 1_000_000 }, 's-bad')).status).toBe(400);

    // The owner raises the desk-agent limit to ₹1,000 and the ceiling to ₹10,000.
    expect((await setPolicy(h, 'u-owner', { agentAuthorityMinor: 100_000, deskCeilingMinor: 1_000_000 }, 's-ok')).status).toBe(200);
    expect((await getPolicy(h, 'u-mgr')).body).toMatchObject({ agentAuthorityMinor: 100_000, deskCeilingMinor: 1_000_000, isDefault: false });

    // ₹800 — was above the old ₹500 limit (would have needed approval), now within the new ₹1,000 limit.
    const res = await comp(h, 'u-mgr', 'k1', { kind: 'goodwill_credit', amountMinor: 80_000, reason: 'repeat visit, kept waiting' }, 'c-new');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ granted: true, outcome: 'granted' });
  });

  it('is gated, 404s an unknown case, and the grant survives a restart', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1');
    expect((await comp(h, 'u-cash', 'k1', { kind: 'refund', amountMinor: 10_000, reason: 'x' }, 'c-cash')).status).toBe(403);
    expect((await comp(h, 'u-mgr', 'ghost', { kind: 'refund', amountMinor: 10_000, reason: 'x' }, 'c-ghost')).status).toBe(404);

    await comp(h, 'u-mgr', 'k1', { kind: 'goodwill_credit', amountMinor: 25_000, reason: 'sorry for the wait' }, 'c-persist');
    const restarted = apiHarness({ store: h.store });
    expect(((await comps(restarted, 'u-owner', 'k1')).body as { count: number; totalMinor: number })).toMatchObject({ count: 1, totalMinor: 25_000 });
  });
});
