import { describe, it, expect } from 'vitest';
import { createOrderRefundsSession, paiseOf, rupees } from '../../apps/web-erp/src/order-refunds-session';
import { actionDetails } from '../../services/identity/src/approval-requests';

// M18-FR-04: the Order refunds page asks a second person for EXACTLY the refund it will send (the engine fingerprints the
// details), sends no card data (only the order's own token is ever used, by head office), and refuses the cheap things
// before any request.

describe('the Order refunds session (M18-FR-04)', () => {
  it('the approval asked for carries exactly the details the refund will send', async () => {
    const asked: { path: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (path: string, init?: { body?: string }) => {
      asked.push({ path: String(path), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      return new Response(JSON.stringify({ requestId: 'apr-1', refund: { effectiveState: 'issued' } }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const s = createOrderRefundsSession({ viewer: { userId: 'u-mgr', permissions: ['order.read', 'order.refund.issue'] }, fetch, newRefundId: () => 'rf-1' });
    const a = await s.ask({ orderId: ' o-1 ', amount: '1,250.5', basis: 'goodwill', reason: ' late ' });
    expect(a.result).toBe('ok');
    if (a.result !== 'ok') return;
    await s.issue(a.value.draft, a.value.requestId);
    const [ask, issue] = asked;
    expect(ask!.path).toBe('/v1/approvals/requests');
    expect(ask!.body).toMatchObject({ kind: 'order_refund', subjectRef: 'o-1/rf-1', valueMinor: 125_050 });
    expect(issue!.path).toBe('/v1/orders/o-1/refunds');
    // The engine's own rule: the action's body (less the approval) plus the path ids is what was approved.
    expect(ask!.body['details']).toEqual(actionDetails(issue!.body, { orderId: 'o-1' }));
    expect(issue!.body).toEqual({ refundId: 'rf-1', amountMinor: 125_050, basis: 'goodwill', reason: 'late', approvalId: 'apr-1' });
    expect(JSON.stringify(asked)).not.toMatch(/\d{13,19}/);
  });

  it('refuses before any request: no order, no amount, no reason, no statement line, no permission', async () => {
    let calls = 0;
    const fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const s = createOrderRefundsSession({ viewer: { userId: 'u-mgr', permissions: ['order.read', 'order.refund.issue'] }, fetch });
    expect(await s.money(' ')).toEqual({ result: 'invalid', why: 'needOrder' });
    expect(await s.ask({ orderId: 'o-1', amount: '0', basis: 'goodwill', reason: 'x' })).toEqual({ result: 'invalid', why: 'needAmount' });
    expect(await s.ask({ orderId: 'o-1', amount: '1.234', basis: 'goodwill', reason: 'x' })).toEqual({ result: 'invalid', why: 'needAmount' });
    expect(await s.ask({ orderId: 'o-1', amount: '10', basis: 'goodwill', reason: ' ' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.outcome('o-1', 'rf-1', 'refunded', ' ')).toEqual({ result: 'invalid', why: 'needStatement' });
    const cashier = createOrderRefundsSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch });
    expect(await cashier.pending()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await cashier.ask({ orderId: 'o-1', amount: '10', basis: 'goodwill', reason: 'x' })).toEqual({ result: 'invalid', why: 'cannotIssue' });
    expect(calls).toBe(0);
  });

  it('rupees both ways in whole paise', () => {
    expect(paiseOf('₹1,250.50')).toBe(125_050);
    expect(paiseOf('40')).toBe(4_000);
    expect(paiseOf('abc')).toBeUndefined();
    expect(rupees(125_050)).toBe('₹1,250.50');
  });
});
