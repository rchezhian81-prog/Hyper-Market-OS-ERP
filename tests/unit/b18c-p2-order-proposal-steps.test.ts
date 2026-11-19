import { describe, it, expect } from 'vitest';
import { applyProposalStep, type ProposalStepRecord } from '../../services/purchase/src/purchase-order-proposal-steps';
import type { StoredPurchaseOrder } from '../../services/purchase/src/purchase-orders';
import { ordersSentBackTo, ordersWaitingToIssue } from '../../packages/purchasing/src/orders-waiting-to-issue';
import { createOrdersToIssueSession, ORDERS_TO_ISSUE_WORDS } from '../../apps/web-erp/src/orders-to-issue-session';

/** P2 · batch 18c (M06-FR-02 · OB-871): the fold of a step, the sent-back list, and the page's session. */

const po = (over: Partial<StoredPurchaseOrder> = {}): StoredPurchaseOrder => ({
  poId: 'po-1', number: 'po-1', supplierId: 'sup', requisitionedBy: 'u-buyer', at: '2026-11-19T05:00:00.000Z',
  lines: [{ productId: 'p', orderedQty: 10, unitCost: { minor: 100, currency: 'INR' } }], totalMinor: 1_000, currency: 'INR',
  status: 'proposed', approvedBy: null, issuedAt: null, receivedByProduct: {}, cancelledByProduct: {}, amendmentCount: 0, ...over,
} as StoredPurchaseOrder);
const step = (s: Partial<ProposalStepRecord>): ProposalStepRecord => ({ poId: 'po-1', stepId: 'x', step: 'rejected', by: 'u-owner', at: 't', reason: 'r', ...s });

describe('P2: a step on a waiting order', () => {
  it('moves a waiting order and keeps who, when and why; never touches an issued one', () => {
    expect(applyProposalStep(po(), step({ step: 'sent_back' })).status).toBe('sent_back');
    expect(applyProposalStep(po(), step({ step: 'rejected' })).proposalSteps).toEqual([{ step: 'rejected', by: 'u-owner', at: 't', reason: 'r' }]);
    const issued = po({ status: 'issued' });
    expect(applyProposalStep(issued, step({ step: 'rejected' }))).toBe(issued);
    expect(applyProposalStep(po({ status: 'rejected' }), step({ step: 'withdrawn' })).status).toBe('rejected');
    expect(applyProposalStep(po({ status: 'proposed' }), step({ step: 'resubmitted' })).status).toBe('proposed');
    const re = applyProposalStep(po({ status: 'sent_back' }), step({ step: 'resubmitted', lines: [{ productId: 'p', orderedQty: 4, unitCost: { minor: 100, currency: 'INR' } }], totalMinor: 400 }));
    expect([re.status, re.totalMinor, re.lines[0]!.orderedQty]).toEqual(['proposed', 400, 4]);
  });

  it('lists only the viewer\'s sent-back orders, with the note; a waiting order shows its last step', () => {
    const body = { orders: [
      { poId: 'A', status: 'sent_back', requisitionedBy: 'u-buyer', at: '1', lines: [{ productId: 'p', orderedQty: 3, unitCost: { minor: 10 } }], proposalSteps: [{ step: 'sent_back', by: 'u-owner', at: 't', reason: 'too many' }] },
      { poId: 'B', status: 'sent_back', requisitionedBy: 'u-other', at: '1', lines: [] },
      { poId: 'C', status: 'proposed', requisitionedBy: 'u-buyer', at: '1', lines: [], proposalSteps: [{ step: 'sent_back', by: 'u-owner', at: 't', reason: 'x' }, { step: 'resubmitted', by: 'u-buyer', at: 't2', reason: 'cut' }] },
      { poId: 'D', status: 'rejected', requisitionedBy: 'u-buyer', at: '1', lines: [] },
    ] };
    const back = ordersSentBackTo(body, { userId: 'u-buyer' });
    expect(back.map((o) => [o.poId, o.lastStep?.reason, o.lines[0]?.orderedQty])).toEqual([['A', 'too many', 3]]);
    expect(ordersSentBackTo(body, { userId: null })).toEqual([]);
    expect(ordersWaitingToIssue(body, { userId: 'u-owner' }).map((o) => [o.poId, o.lastStep?.step])).toEqual([['C', 'resubmitted']]);
  });

  it('the page sends one POST per step, nothing without a reason, and never lets the raiser reject or send back', async () => {
    const sent: { path: string; body: unknown }[] = [];
    const s = createOrdersToIssueSession(async (r) => { sent.push({ path: r.path, body: r.body }); return r.path.endsWith('/rejection') ? { status: 409, body: { error: { whatHappened: 'already issued' } } } : { status: 200, body: {} }; }, { userId: 'u-owner', permissions: ['purchase.order.approve'] });
    expect(await s.sendBack({ poId: 'po-1', raisedByViewer: false }, '  ')).toEqual({ kind: 'needs_note' });
    expect(await s.reject({ poId: 'po-1', raisedByViewer: true }, 'x')).toEqual({ kind: 'not_yours' });
    expect(sent).toEqual([]);
    expect(await s.sendBack({ poId: 'po-1', raisedByViewer: false }, 'fix it')).toEqual({ kind: 'stepped', step: 'sent_back' });
    const refused = await s.reject({ poId: 'po-1', raisedByViewer: false }, 'no');
    expect(s.outcomeWords('en', refused)).toBe('Head office did not do it: already issued');
    await s.resubmit({ poId: 'po-1', raisedByViewer: true }, 'cut', [{ productId: 'p', orderedQty: 4 }]);
    await s.withdraw({ poId: 'po-1', raisedByViewer: true }, 'mistake');
    expect(sent.map((x) => x.path)).toEqual(['/v1/purchase/orders/po-1/send-back', '/v1/purchase/orders/po-1/rejection', '/v1/purchase/orders/po-1/resubmission', '/v1/purchase/orders/po-1/withdrawal']);
    expect(sent[2]!.body).toEqual({ reason: 'cut', lines: [{ productId: 'p', orderedQty: 4 }] });
    expect(s.outcomeWords('ta', { kind: 'stepped', step: 'withdrawn' })).toBe(ORDERS_TO_ISSUE_WORDS.ta.withdrawn);
  });
});
