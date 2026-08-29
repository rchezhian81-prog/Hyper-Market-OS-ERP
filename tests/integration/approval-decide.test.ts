import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **Deciding an approval under separation of duties, end to end (M02-FR-03 · §28 · P-04 · hard rule #4, API-01).**
 *
 * The maker-checker rule, on the cloud, with the loophole most people actually try: a manager going on
 * leave delegates their approval authority to the very person whose requests need approving — a
 * self-approval with an extra step. The decider is ALWAYS the authenticated caller, never a name from
 * the body, and their authority (own, a live delegation, or none) is computed from the same delegation
 * store as effective-authority. This drives the tested `decideWithDelegation` through the real surface.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const inr = (minor: number) => ({ minor, currency: 'INR' });
const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const decide = (h: ApiHarness, u: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/access/approvals/decide', userId: u, tenantId: A, idempotencyKey: key, body });
const grant = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/access/delegations/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });

// A refund request raised by someone else, in branch b1.
const refundBy = (requestedBy: string, value = inr(20_000)) =>
  ({ id: `req-${requestedBy}`, subjectType: 'refund', subjectRef: 'sale-99', requestedBy, branchId: 'b1', value });
// The decider's own approver record — where they may approve and up to what.
const ownAuthority = (authorityLimit: { minor: number; currency: string } | null) =>
  ({ userId: 'u-mgr', branchScope: ['b1'], authorityLimit });

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // approvals.delegation.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('deciding an approval under §28 (M02-FR-03)', () => {
  it('approves someone else’s request when the decider holds the authority — recorded in their OWN name', async () => {
    const h = await seeded();
    const res = await decide(h, 'u-mgr', {
      request: refundBy('u-clerk'), decision: 'approved', reason: 'receipt checked, within policy',
      own: ownAuthority(inr(100_000)),
    }, 'dec-ok');
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; decision: { status: string; decidedBy: string; onBehalfOf?: string; reason: string } };
    expect(body.ok).toBe(true);
    expect(body.decision.status).toBe('approved');
    expect(body.decision.decidedBy).toBe('u-mgr');       // the caller, from the token
    expect(body.decision.onBehalfOf).toBeUndefined();    // acted on own authority
  });

  it('refuses the maker deciding their own request — directly, and through a delegation aimed back at them', async () => {
    const h = await seeded();
    // Direct self-approval: the caller is the requester.
    const selfReq = { id: 'req-self', subjectType: 'refund', subjectRef: 'sale-1', requestedBy: 'u-mgr', branchId: 'b1', value: inr(10_000) };
    const direct = await decide(h, 'u-mgr', { request: selfReq, decision: 'approved', reason: 'mine', own: ownAuthority(inr(100_000)) }, 'dec-self');
    expect(direct.status).toBe(422);
    expect(codeOf(direct)).toBe('self_approval_forbidden');

    // The loophole: u-boss delegates their authority to u-mgr, who then tries to approve u-boss's OWN request.
    await grant(h, 'u-owner', 'd-cover', {
      fromUserId: 'u-boss', toUserId: 'u-mgr', fromDate: day(0), untilDate: day(10), subjectTypes: ['refund'],
      reason: 'annual leave', granter: { userId: 'u-boss', branchScope: ['b1'], authorityLimit: inr(50_000) }, valueCap: inr(30_000), branchScope: ['b1'],
    }, 'g-cover');
    // No own authority in the body → u-mgr acts on u-boss's delegated authority, aimed back at u-boss.
    const loophole = await decide(h, 'u-mgr', { request: refundBy('u-boss'), decision: 'approved', reason: 'covering' }, 'dec-loophole');
    expect(loophole.status).toBe(422);
    expect(codeOf(loophole)).toBe('delegation_to_maker_forbidden');
  });

  it('refuses a decision beyond the decider’s own cap — escalate, never widen', async () => {
    const h = await seeded();
    const res = await decide(h, 'u-mgr', {
      request: refundBy('u-clerk', inr(50_000)), decision: 'approved', reason: 'big refund',
      own: ownAuthority(inr(10_000)),
    }, 'dec-over');
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('exceeds_authority');
  });

  it('refuses an unreadable decision without changing anything', async () => {
    const h = await seeded();
    const res = await decide(h, 'u-mgr', { request: { id: 'x' }, decision: 'maybe' }, 'dec-bad');
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('not_readable_as_a_decision');
  });

  it('is closed to a caller without the approvals permission', async () => {
    const h = await seeded();
    const res = await decide(h, 'u-cash', { request: refundBy('u-clerk'), decision: 'approved', reason: 'x', own: ownAuthority(inr(100_000)) }, 'dec-403');
    expect(res.status).toBe(403);
  });
});
