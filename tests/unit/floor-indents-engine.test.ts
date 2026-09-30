import { describe, it, expect } from 'vitest';
import {
  requestIndent, approveIndent, rejectIndent, planIssue, applyIssue, planReceipt, applyReceipt, cancelIndent,
  planReturn, applyReturnRequest, returnTransfer, planReturnAcceptance, applyReturnAcceptance, indentTotals, indentAttention,
  IndentRefusedError, type FloorIndent,
} from '../../packages/warehouse/src/indents';
import { dispatchTransfer, receiveTransfer } from '../../packages/warehouse/src/transfers';

/**
 * SP-8 (F08 · WF-06 · WF-07 · M09-FR-03 · M08-FR-02 · §28 · hard rule #2): the floor indent's pure lifecycle. It moves no
 * stock — every issue and receipt is a transfer through the existing engines — and remembers requested / allocated /
 * issued / received / in transit / shortfall / returned / outstanding SEPARATELY, derived and never stored twice. Four
 * separations are the engine's own: requester ≠ approver, requester ≠ issuer, issuer ≠ receiver, returner ≠ acceptor.
 */

const AT = '2026-09-30T09:00:00.000Z';
const LATER = '2026-09-30T10:00:00.000Z';
const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof IndentRefusedError) return e.code; throw e; }
  throw new Error('expected a refusal');
};

const requested = (): FloorIndent => requestIndent({
  indentId: 'ind-1', fromLocationId: 'S1-BACK', toLocationId: 'S1', requestedBy: 'u-floor', at: AT, reason: 'shelf 4 is empty',
  lines: [{ productId: 'RICE', requestedMinor: 20, uom: 'EA' }, { productId: 'OIL', requestedMinor: 6, uom: 'EA' }],
});
const approved = (): FloorIndent => approveIndent({ indent: requested(), approvedBy: 'u-mgr', at: AT, available: [{ productId: 'RICE', onHandMinor: 50 }, { productId: 'OIL', onHandMinor: 4 }] });

describe('request and approval — the floor asks; a DIFFERENT person allocates against head office\'s own back-store stock', () => {
  it('records the ask with nothing allocated, nothing owed; refuses an empty, self-directed or duplicated ask', () => {
    const i = requested();
    expect(i.state).toBe('requested');
    expect(indentTotals(i)).toMatchObject({ requestedMinor: 26, allocatedMinor: 0, issuedMinor: 0, outstandingMinor: 0, inTransitMinor: 0 });
    expect(indentAttention(i)).toEqual(['awaiting_approval']);
    expect(refusal(() => requestIndent({ indentId: 'x', fromLocationId: 'A', toLocationId: 'A', requestedBy: 'u', at: AT, lines: [{ productId: 'P', requestedMinor: 1, uom: 'EA' }] }))).toBe('same_place');
    expect(refusal(() => requestIndent({ indentId: 'x', fromLocationId: 'A', toLocationId: 'B', requestedBy: 'u', at: AT, lines: [] }))).toBe('not_readable_as_an_indent');
    expect(refusal(() => requestIndent({ indentId: 'x', fromLocationId: 'A', toLocationId: 'B', requestedBy: 'u', at: AT, lines: [{ productId: 'P', requestedMinor: 1, uom: 'EA' }, { productId: 'P', requestedMinor: 2, uom: 'EA' }] }))).toBe('duplicate_product');
    expect(refusal(() => requestIndent({ indentId: 'x', fromLocationId: 'A', toLocationId: 'B', requestedBy: 'u', at: AT, lines: [{ productId: 'P', requestedMinor: 0, uom: 'EA' }] }))).toBe('not_readable_as_an_indent');
  });

  it('allocates min(requested, on-hand) by default and SAYS a short back store; the approver may allocate less, never more; the requester never approves', () => {
    const a = approved();
    expect(a.state).toBe('approved');
    expect(a.allocations).toEqual([{ productId: 'RICE', allocatedMinor: 20, availableMinor: 50 }, { productId: 'OIL', allocatedMinor: 4, availableMinor: 4 }]);
    expect(a.flags).toEqual(['short_stock', 'short_allocated']);
    expect(indentTotals(a)).toMatchObject({ allocatedMinor: 24, outstandingMinor: 24 });
    expect(indentAttention(a)).toEqual(['owed_by_back_store']);
    const cut = approveIndent({ indent: requested(), approvedBy: 'u-mgr', at: AT, available: [{ productId: 'RICE', onHandMinor: 50 }, { productId: 'OIL', onHandMinor: 50 }], allocations: [{ productId: 'RICE', quantityMinor: 10 }] });
    expect(cut.allocations).toEqual([{ productId: 'RICE', allocatedMinor: 10, availableMinor: 50 }, { productId: 'OIL', allocatedMinor: 6, availableMinor: 50 }]);
    expect(cut.flags).toEqual(['short_allocated']);
    expect(refusal(() => approveIndent({ indent: requested(), approvedBy: 'u-mgr', at: AT, available: [], allocations: [{ productId: 'RICE', quantityMinor: 21 }] }))).toBe('over_allocation');
    expect(refusal(() => approveIndent({ indent: requested(), approvedBy: 'u-mgr', at: AT, available: [], allocations: [{ productId: 'GHEE', quantityMinor: 1 }] }))).toBe('not_on_indent');
    expect(refusal(() => approveIndent({ indent: requested(), approvedBy: 'u-floor', at: AT, available: [] }))).toBe('self_approval');
    expect(refusal(() => approveIndent({ indent: requested(), approvedBy: 'u-mgr', at: AT, available: [{ productId: 'RICE', onHandMinor: 0 }, { productId: 'OIL', onHandMinor: 0 }] }))).toBe('nothing_allocated');
    expect(refusal(() => approveIndent({ indent: approved(), approvedBy: 'u-mgr', at: AT, available: [] }))).toBe('indent_not_requested');
    // Unreadable stock is said as null, never assumed to be plenty — the allocation defaults to the ask.
    const blind = approveIndent({ indent: requested(), approvedBy: 'u-mgr', at: AT, available: [] });
    expect(blind.allocations![0]).toEqual({ productId: 'RICE', allocatedMinor: 20, availableMinor: null });
    expect(blind.flags).toEqual([]);
  });

  it('rejects with a reason — a different person, nothing moves', () => {
    const r = rejectIndent({ indent: requested(), rejectedBy: 'u-mgr', at: AT, reason: 'not stocked any more' });
    expect(r).toMatchObject({ state: 'rejected', rejectedBy: 'u-mgr', rejectionReason: 'not stocked any more' });
    expect(refusal(() => rejectIndent({ indent: requested(), rejectedBy: 'u-floor', at: AT, reason: 'x' }))).toBe('self_approval');
    expect(indentTotals(r).outstandingMinor).toBe(0);
  });
});

describe('issue — each issue is a transfer in the requester\'s name, dispatched by the back store (a second person)', () => {
  it('plans a partial issue, the transfer engine dispatches it, the indent is issuing with the remainder owed; a second issue closes it', () => {
    const a = approved();
    const plan = planIssue({ indent: a, issueId: 'is-1', issuedBy: 'u-back', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 12 }], unitCostsMinor: { RICE: 5_000 }, currency: 'INR', at: AT });
    expect(plan.transfer).toMatchObject({ transferId: 'ind-1:is-1', fromLocationId: 'S1-BACK', toLocationId: 'S1', state: 'proposed', requestedBy: 'u-floor' });
    expect(plan.transfer.lines).toEqual([{ productId: 'RICE', batchId: null, quantityMinor: 12, uom: 'EA', unitCost: { minor: 5_000, currency: 'INR' } }]);
    // The transfer engine's own §28: the dispatcher (issuer) is not the requester → dispatch goes.
    const d = dispatchTransfer({ transfer: plan.transfer, approval: { subjectRef: plan.transfer.transferId, status: 'approved', decidedBy: 'u-back' }, available: [{ productId: 'RICE', batchId: null, quantityMinor: 50, state: 'on_hand' }], at: AT });
    expect(d.transfer.state).toBe('in_transit');
    const issuing = applyIssue(a, plan.issue);
    expect(issuing.state).toBe('issuing');
    expect(issuing.flags).toContain('partial_issue');
    expect(indentTotals(issuing)).toMatchObject({ allocatedMinor: 24, issuedMinor: 12, inTransitMinor: 12, outstandingMinor: 12, receivedMinor: 0 });
    expect(indentTotals(issuing).lines.find((l) => l.productId === 'RICE')).toMatchObject({ issuedMinor: 12, outstandingMinor: 8 });
    expect(indentAttention(issuing)).toEqual(['owed_by_back_store', 'on_the_trolley']);

    const second = planIssue({ indent: issuing, issueId: 'is-2', issuedBy: 'u-back', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 8 }, { productId: 'OIL', batchId: 'B1', quantityMinor: 4 }], unitCostsMinor: {}, currency: 'INR', at: LATER });
    expect(second.transfer.lines[1]).toMatchObject({ productId: 'OIL', batchId: 'B1', unitCost: { minor: 0, currency: 'INR' } }); // unvalued → 0, said by the adapter as null cost at dispatch
    const issued = applyIssue(issuing, second.issue);
    expect(issued.state).toBe('issued');
    expect(indentTotals(issued)).toMatchObject({ issuedMinor: 24, inTransitMinor: 24, outstandingMinor: 0 });
  });

  it('refuses the requester issuing to themselves, a wrong item, an over-issue, a duplicate issue id and an unapproved indent — nothing planned', () => {
    const a = approved();
    const one = (over: Partial<Parameters<typeof planIssue>[0]>) => planIssue({ indent: a, issueId: 'is-1', issuedBy: 'u-back', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 1 }], unitCostsMinor: {}, currency: 'INR', at: AT, ...over });
    expect(refusal(() => one({ issuedBy: 'u-floor' }))).toBe('requester_cannot_issue');
    expect(refusal(() => one({ lines: [{ productId: 'GHEE', batchId: null, quantityMinor: 1 }] }))).toBe('not_on_indent');
    expect(refusal(() => one({ lines: [{ productId: 'RICE', batchId: null, quantityMinor: 21 }] }))).toBe('over_issue');
    expect(refusal(() => one({ lines: [{ productId: 'RICE', batchId: 'A', quantityMinor: 15 }, { productId: 'RICE', batchId: 'B', quantityMinor: 6 }] }))).toBe('over_issue'); // 21 across two batches
    expect(refusal(() => one({ lines: [{ productId: 'OIL', batchId: null, quantityMinor: 5 }] }))).toBe('over_issue'); // only 4 allocated
    expect(refusal(() => one({ lines: [] }))).toBe('over_issue');
    expect(refusal(() => one({ indent: requested() }))).toBe('indent_not_approved');
    const withOne = applyIssue(a, one({}).issue);
    expect(refusal(() => planIssue({ indent: withOne, issueId: 'is-1', issuedBy: 'u-back', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 1 }], unitCostsMinor: {}, currency: 'INR', at: AT }))).toBe('over_issue');
  });
});

describe('independent floor receipt — a different person counts; what arrived is on the shelf, a shortfall is a valued exception', () => {
  const issued = (): { indent: FloorIndent; transferAfterDispatch: ReturnType<typeof dispatchTransfer>['transfer'] } => {
    const a = approved();
    const plan = planIssue({ indent: a, issueId: 'is-1', issuedBy: 'u-back', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 12 }], unitCostsMinor: { RICE: 5_000 }, currency: 'INR', at: AT });
    const d = dispatchTransfer({ transfer: plan.transfer, approval: { subjectRef: plan.transfer.transferId, status: 'approved', decidedBy: 'u-back' }, available: [{ productId: 'RICE', batchId: null, quantityMinor: 50, state: 'on_hand' }], at: AT });
    return { indent: applyIssue(a, plan.issue), transferAfterDispatch: d.transfer };
  };

  it('receives 10 of 12: on-hand at the floor for 10, a shortfall of 2 valued at the back store\'s cost; the indent stays open for the remainder still owed', () => {
    const { indent, transferAfterDispatch } = issued();
    const issue = planReceipt({ indent, issueId: 'is-1', receivedBy: 'u-floor2', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }] });
    expect(issue.issueId).toBe('is-1');
    const r = receiveTransfer({ transfer: transferAfterDispatch, counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }], receivedBy: 'u-floor2', at: LATER, currency: 'INR' });
    expect(r.discrepancies).toEqual([expect.objectContaining({ productId: 'RICE', dispatchedMinor: 12, receivedMinor: 10, differenceMinor: -2, value: { minor: 10_000, currency: 'INR' } })]);
    const after = applyReceipt(indent, 'is-1', { receivedBy: 'u-floor2', at: LATER, received: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }], shortfall: [{ productId: 'RICE', batchId: null, quantityMinor: 2, valueMinor: 10_000 }] });
    expect(after.issues[0]).toMatchObject({ state: 'received', receivedBy: 'u-floor2' });
    expect(after.state).toBe('issuing'); // 12 more owed by the back store
    expect(after.flags).toContain('partial_receipt');
    expect(indentTotals(after)).toMatchObject({ issuedMinor: 12, receivedMinor: 10, shortfallMinor: 2, inTransitMinor: 0, outstandingMinor: 12 });
    expect(indentAttention(after)).toEqual(['owed_by_back_store', 'arrived_short']);
  });

  it('closes as received once every issue is received and nothing is owed; refuses the issuer receiving their own issue, a wrong item and an unknown or already-received issue', () => {
    const { indent } = issued();
    expect(refusal(() => planReceipt({ indent, issueId: 'is-1', receivedBy: 'u-back', counted: [] }))).toBe('issuer_cannot_receive');
    expect(refusal(() => planReceipt({ indent, issueId: 'is-1', receivedBy: 'u-floor2', counted: [{ productId: 'OIL', batchId: null, quantityMinor: 1 }] }))).toBe('not_on_issue');
    expect(refusal(() => planReceipt({ indent, issueId: 'is-9', receivedBy: 'u-floor2', counted: [] }))).toBe('issue_unknown');
    // The requester MAY receive (they asked; the issuer is the separation that matters at the floor).
    expect(planReceipt({ indent, issueId: 'is-1', receivedBy: 'u-floor', counted: [] }).issueId).toBe('is-1');
    const done = applyReceipt(indent, 'is-1', { receivedBy: 'u-floor', at: LATER, received: [{ productId: 'RICE', batchId: null, quantityMinor: 12 }], shortfall: [] });
    expect(refusal(() => planReceipt({ indent: done, issueId: 'is-1', receivedBy: 'u-floor2', counted: [] }))).toBe('issue_already_received');
    // Cancel the remainder → nothing owed and everything issued received → the indent is received.
    const closed = cancelIndent({ indent: done, cancelledBy: 'u-mgr', at: LATER, reason: 'shelf refilled from a delivery' });
    expect(closed.state).toBe('received');
    expect(closed.flags).toContain('cancelled_remainder');
    expect(indentTotals(closed)).toMatchObject({ outstandingMinor: 0, receivedMinor: 12 });
    expect(indentAttention(closed)).toEqual([]);
  });
});

describe('cancel and return', () => {
  it('cancel before anything went → cancelled; after an issue → the remainder is withdrawn but the trolley must still be received; a closed indent cannot be cancelled', () => {
    const c = cancelIndent({ indent: approved(), cancelledBy: 'u-floor', at: AT, reason: 'ordered twice' });
    expect(c).toMatchObject({ state: 'cancelled', remainderCancelled: true, cancelReason: 'ordered twice' });
    expect(indentTotals(c).outstandingMinor).toBe(0);
    const a = approved();
    const plan = planIssue({ indent: a, issueId: 'is-1', issuedBy: 'u-back', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 5 }], unitCostsMinor: {}, currency: 'INR', at: AT });
    const partial = cancelIndent({ indent: applyIssue(a, plan.issue), cancelledBy: 'u-mgr', at: LATER, reason: 'enough' });
    expect(partial.state).toBe('issued');
    expect(indentTotals(partial)).toMatchObject({ issuedMinor: 5, inTransitMinor: 5, outstandingMinor: 0 });
    expect(refusal(() => planIssue({ indent: partial, issueId: 'is-2', issuedBy: 'u-back', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 1 }], unitCostsMinor: {}, currency: 'INR', at: AT }))).toBe('indent_not_approved');
    expect(refusal(() => cancelIndent({ indent: c, cancelledBy: 'u-floor', at: AT, reason: 'again' }))).toBe('indent_not_open');
  });

  it('a return needs something received, only what the indent brought, accepted by a different person; the return transfer runs floor → back store in the returner\'s name', () => {
    const a = approved();
    const plan = planIssue({ indent: a, issueId: 'is-1', issuedBy: 'u-back', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 12 }], unitCostsMinor: {}, currency: 'INR', at: AT });
    const issuing = applyIssue(a, plan.issue);
    expect(refusal(() => planReturn({ indent: issuing, returnId: 'rt-1', returnedBy: 'u-floor', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 1 }], reason: 'x', at: AT }))).toBe('nothing_received');
    const received = applyReceipt(issuing, 'is-1', { receivedBy: 'u-floor', at: LATER, received: [{ productId: 'RICE', batchId: null, quantityMinor: 12 }], shortfall: [] });
    expect(refusal(() => planReturn({ indent: received, returnId: 'rt-1', returnedBy: 'u-floor', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 13 }], reason: 'x', at: AT }))).toBe('over_return');
    expect(refusal(() => planReturn({ indent: received, returnId: 'rt-1', returnedBy: 'u-floor', lines: [{ productId: 'GHEE', batchId: null, quantityMinor: 1 }], reason: 'x', at: AT }))).toBe('not_on_indent');
    const ret = planReturn({ indent: received, returnId: 'rt-1', returnedBy: 'u-floor', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 3 }], reason: 'wrong grade on the shelf', at: LATER });
    expect(ret).toMatchObject({ returnId: 'rt-1', transferId: 'ind-1:return:rt-1', state: 'requested' });
    const pending = applyReturnRequest(received, ret);
    // 12 of the 24 allocated are still owed by the back store, and the return waits for it too.
    expect(indentAttention(pending)).toEqual(['owed_by_back_store', 'return_awaiting_back_store']);
    // A second return cannot claim what the first already asked to send back.
    expect(refusal(() => planReturn({ indent: pending, returnId: 'rt-2', returnedBy: 'u-floor', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }], reason: 'x', at: AT }))).toBe('over_return');
    const t = returnTransfer(pending, ret, { RICE: 4_800 }, 'INR');
    expect(t).toMatchObject({ transferId: 'ind-1:return:rt-1', fromLocationId: 'S1', toLocationId: 'S1-BACK', requestedBy: 'u-floor', state: 'proposed' });
    expect(refusal(() => planReturnAcceptance({ indent: pending, returnId: 'rt-1', acceptedBy: 'u-floor', counted: [] }))).toBe('returner_cannot_accept');
    expect(refusal(() => planReturnAcceptance({ indent: pending, returnId: 'rt-1', acceptedBy: 'u-back', counted: [{ productId: 'OIL', batchId: null, quantityMinor: 1 }] }))).toBe('not_on_return');
    expect(refusal(() => planReturnAcceptance({ indent: pending, returnId: 'rt-9', acceptedBy: 'u-back', counted: [] }))).toBe('return_unknown');
    // The back store dispatches (as the second person) and receives in one step through the transfer engines.
    const d = dispatchTransfer({ transfer: t, approval: { subjectRef: t.transferId, status: 'approved', decidedBy: 'u-back' }, available: [{ productId: 'RICE', batchId: null, quantityMinor: 12, state: 'on_hand' }], at: LATER });
    const r = receiveTransfer({ transfer: d.transfer, counted: [{ productId: 'RICE', batchId: null, quantityMinor: 3 }], receivedBy: 'u-back', at: LATER, currency: 'INR' });
    expect(r.discrepancies).toEqual([]);
    const accepted = applyReturnAcceptance(pending, 'rt-1', { acceptedBy: 'u-back', at: LATER, received: [{ productId: 'RICE', batchId: null, quantityMinor: 3 }], shortfall: [] });
    expect(accepted.returns[0]).toMatchObject({ state: 'accepted', acceptedBy: 'u-back' });
    expect(indentTotals(accepted)).toMatchObject({ receivedMinor: 12, returnedMinor: 3 });
    expect(refusal(() => planReturnAcceptance({ indent: accepted, returnId: 'rt-1', acceptedBy: 'u-back', counted: [] }))).toBe('return_already_accepted');
  });
});
