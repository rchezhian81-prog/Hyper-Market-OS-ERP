import { describe, it, expect } from 'vitest';
import {
  refundApprovalRoutes, takeRefundApproval, approvalIdIn, namedApproverRefusal,
  REFUND_APPROVAL_MINUTES, type RefundApproval, type RefundApprovalState,
} from '../../services/pos/src/refund-approvals';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * **A refund approval at head office is the approver's own act (ADR-0022 · Wave 2b-v-c · audit PF-02 · M13-FR-01/02/03 ·
 * §28).** The audit's finding: a refund body NAMED a provisioned manager who never signed in or approved, and the
 * route checked only that the name held the authority. Here, route-level with stubbed stores: the approval is given in
 * the approver's own session, for one kind, one bill, one amount and one processor, never by the processor; and a
 * refund may spend it only when every one of those matches, it has not expired, it is unspent, and its approver still
 * holds the authority.
 */

const NOW = '2026-10-06T10:00:00.000Z';
const T = 't-sre';

function stub(people: Record<string, readonly string[]> = {
  'u-cash': ['pos.return.record'], 'u-mgr': ['pos.return.approve', 'pos.return.record'], 'u-acct': ['finance.read'],
}) {
  const given: RefundApproval[] = [];
  const routes = refundApprovalRoutes({
    recordRefundApproval: (_t, a) => { given.push(a); },
    permissionsOfUser: (_t, u) => people[u],
    now: () => NOW,
  });
  return { given, routes };
}
const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: T, userId: 'u-mgr', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const give = (routes: readonly Route[], body: unknown, userId = 'u-mgr') =>
  routes.find((r) => r.method === 'POST' && r.path === '/v1/pos/refund-approvals')!.handler(ctx({ body, userId }));
interface Thrown { readonly status: number; readonly body: { readonly code: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected a refusal');
}
const ask = (over: Record<string, unknown> = {}) => ({ kind: 'refund', saleId: 'S1', valueMinor: 5000, requestedBy: 'u-cash', reason: 'damaged on the shelf', ...over });

describe('the approver gives the approval, in their own session (POST /v1/pos/refund-approvals)', () => {
  it('is gated on the authority to approve, and is idempotent through the kernel', () => {
    const route = stub().routes.find((r) => r.path === '/v1/pos/refund-approvals')!;
    expect(route.permission).toBe('pos.return.approve');
    expect(route.idempotent).toBe(true);
  });

  it('records ONE approval: the caller as approver, for one kind, bill, amount and processor, expiring in fifteen minutes', async () => {
    const { routes, given } = stub();
    const res = await give(routes, ask());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'refund', saleId: 'S1', valueMinor: 5000, requestedBy: 'u-cash', approvedBy: 'u-mgr', reason: 'damaged on the shelf',
      givenAt: NOW, expiresAt: '2026-10-06T10:15:00.000Z',
    });
    expect(REFUND_APPROVAL_MINUTES).toBe(15);
    expect((res.body as RefundApproval).approvalId).toMatch(/^rap-[0-9a-f-]{36}$/);
    expect(given).toEqual([res.body]);
  });

  it('the approver is the signed-in caller — a body cannot say someone else approved', async () => {
    const { routes, given } = stub();
    await give(routes, ask({ approvedBy: 'u-owner' }));
    expect(given[0]?.approvedBy).toBe('u-mgr');
  });

  it('never for the person who will process it (§28)', async () => {
    const { routes, given } = stub();
    const e = await thrown(() => give(routes, ask({ requestedBy: 'u-mgr' })));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('self_approval');
    expect(given).toHaveLength(0);
  });

  it('only for a person head office knows who may process refunds', async () => {
    const { routes, given } = stub();
    expect((await thrown(() => give(routes, ask({ requestedBy: 'u-ghost' })))).body.code).toBe('requester_unknown');
    expect((await thrown(() => give(routes, ask({ requestedBy: 'u-acct' })))).body.code).toBe('requester_may_not_process_refunds');
    expect(given).toHaveLength(0);
  });

  it('names what it is for — the kind, the bill (except a return without a receipt), a positive amount, who and why', async () => {
    const { routes, given } = stub();
    for (const bad of [
      ask({ kind: 'anything' }), ask({ saleId: undefined }), ask({ valueMinor: 0 }), ask({ valueMinor: 12.5 }),
      ask({ valueMinor: '5000' }), ask({ requestedBy: ' ' }), ask({ reason: undefined }),
    ]) {
      const e = await thrown(() => give(routes, bad));
      expect(e.status).toBe(400);
      expect(e.body.code).toBe('not_readable_as_a_refund_approval');
    }
    expect((await thrown(() => give(routes, 'not a body'))).status).toBe(400);
    expect(given).toHaveLength(0);
    // A return without a receipt has no bill: the approval is for none, whatever the body says.
    const nr = await give(routes, ask({ kind: 'no_receipt_return', saleId: 'S1' }));
    expect((nr.body as RefundApproval).saleId).toBeNull();
    expect((await give(routes, ask({ kind: 'no_receipt_return', saleId: undefined }))).status).toBe(201);
  });
});

describe('a refund spends an approval only when it is the one approved (takeRefundApproval)', () => {
  const approval: RefundApproval = {
    approvalId: 'rap-1', kind: 'refund', saleId: 'S1', valueMinor: 5000, requestedBy: 'u-cash', approvedBy: 'u-mgr',
    reason: 'r', givenAt: NOW, expiresAt: '2026-10-06T10:15:00.000Z',
  };
  const take = (state: RefundApprovalState | undefined, over: Partial<Parameters<typeof takeRefundApproval>[0]> = {}) =>
    takeRefundApproval({
      state, kind: 'refund', saleId: 'S1', valueMinor: 5000, processedBy: 'u-cash', returnId: 'RT-1', now: '2026-10-06T10:05:00.000Z',
      canApprove: (u) => u === 'u-mgr', ...over,
    });

  it('resolves the approval when everything matches', async () => {
    expect(await take({ approval })).toEqual(approval);
  });

  it('refuses an approval head office never gave', async () => {
    expect((await thrown(() => take(undefined))).body.code).toBe('approval_unknown');
  });

  it('refuses a different kind, bill, amount or processor', async () => {
    expect((await thrown(() => take({ approval }, { kind: 'out_of_window' }))).body.code).toBe('approval_does_not_match');
    expect((await thrown(() => take({ approval }, { saleId: 'S2' }))).body.code).toBe('approval_does_not_match');
    expect((await thrown(() => take({ approval }, { valueMinor: 5001 }))).body.code).toBe('approval_does_not_match');
    expect((await thrown(() => take({ approval }, { processedBy: 'u-cash2' }))).body.code).toBe('approval_does_not_match');
  });

  it('refuses it once it has expired — at the very minute it ends', async () => {
    expect((await thrown(() => take({ approval }, { now: '2026-10-06T10:15:00.000Z' }))).body.code).toBe('approval_expired');
  });

  it('one approval pays one refund: spent by another refund it is refused; the same refund resent may name it again', async () => {
    expect((await thrown(() => take({ approval, usedBy: 'RT-0' }))).body.code).toBe('approval_already_used');
    // The refund that spent it, resent after a lost reply (even past expiry), still resolves — the register dedups it.
    expect(await take({ approval, usedBy: 'RT-1' }, { now: '2026-10-06T11:00:00.000Z' })).toEqual(approval);
  });

  it('refuses it when the approver no longer holds the authority (a leaver, a changed role)', async () => {
    expect((await thrown(() => take({ approval }, { canApprove: () => false }))).body.code).toBe('approver_may_not_approve');
  });

  it('every refusal says nothing moved', async () => {
    const e = await thrown(() => take(undefined)) as unknown as { status: number; body: { wasItSaved: string; nextSafeAction: string } };
    expect(e.status).toBe(422);
    expect(e.body.wasItSaved).toBe('not_saved');
    expect(e.body.nextSafeAction).toMatch(/No money has moved/);
  });
});

describe('a refund names an approval, never a person', () => {
  it('reads the approval id from the body', () => {
    expect(approvalIdIn({ approvalId: ' rap-1 ' })).toBe('rap-1');
    expect(approvalIdIn({ outOfWindowApprovalId: 'rap-2' }, 'outOfWindowApprovalId')).toBe('rap-2');
    expect(approvalIdIn({ approvalId: '' })).toBeUndefined();
    expect(approvalIdIn({ approvalId: 7 })).toBeUndefined();
    expect(approvalIdIn(null)).toBeUndefined();
  });

  it('a name with no approval behind it is refused by name (the audit\'s PF-02 reproduction)', () => {
    const e = namedApproverRefusal('u-mgr', 'approvedBy') as unknown as { status: number; body: { code: string; whatHappened: string; wasItSaved: string } };
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('approver_named_without_approval');
    expect(e.body.whatHappened).toContain('u-mgr');
    expect(e.body.wasItSaved).toBe('not_saved');
  });
});
