import { describe, it, expect } from 'vitest';
import { createRfqSession, addSupplier, rfqStateTone, requisitionLinesText, RFQ_COPY, rfqWords, rfqOutcomeWords } from '../../apps/web-erp/src/rfq-session';
import { createSupplierClaimsSession, claimStateTone, supplierLabel, rupees, SUPPLIER_CLAIMS_COPY, supplierClaimsOutcomeWords } from '../../apps/web-erp/src/supplier-claims-session';
import { rfqState } from '../../services/purchase/src/rfq';

/**
 * **U6 (UI/UX gap audit §27 "Purchase — RFQ" and "Purchase — claims" were PARTIAL): the two pages' tested, DOM-free sessions.**
 *   • the Requests for quotation session refuses the cheap things before any request (nobody signed in, the right not held,
 *     no requisition, no supplier, no day, a note too long) and sends exactly what head office's route takes; a supplier is
 *     added to the list once, never twice; the register's state words and tones; every word in both languages;
 *   • the Supplier claims session gates reading, issuing and deciding on the three different rights, needs a reason to
 *     decide, and calls the two routes that already existed; names for ids; every word in both languages;
 *   • `rfqState` (head office's rule): open until the day passes; overdue after it with a supplier still to answer; answered
 *     once every supplier has.
 */
type Call = { method: string; path: string; body?: unknown };
function stub(answer: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const c: Call = { method: init?.method ?? 'GET', path: String(input), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) };
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const buyer = { userId: 'u-mgr', permissions: ['purchase.commitment.read', 'purchase.order.propose'] };

describe('U6 · the Requests for quotation session', () => {
  it('refuses the cheap things before any request, then sends exactly what the route takes', async () => {
    const { calls, fetch } = stub(() => ({ status: 201, body: { rfq: { rfqId: 'rfq-x' } } }));
    const nobody = createRfqSession({ viewer: undefined, fetch });
    expect(await nobody.send({ requisitionId: 'rq-1', supplierIds: ['sup-a'], dueOn: '2099-01-10', note: '' })).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createRfqSession({ viewer: { userId: 'u-acct', permissions: ['purchase.commitment.read'] }, fetch });
    expect(reader.may).toEqual({ named: true, read: true, send: false });
    expect(await reader.send({ requisitionId: 'rq-1', supplierIds: ['sup-a'], dueOn: '2099-01-10', note: '' })).toEqual({ result: 'invalid', why: 'cannotSend' });
    const s = createRfqSession({ viewer: buyer, fetch, newKey: () => 'k', newId: () => 'rfq-x' });
    expect(await s.send({ requisitionId: ' ', supplierIds: ['sup-a'], dueOn: '2099-01-10', note: '' })).toEqual({ result: 'invalid', why: 'needRequisition' });
    expect(await s.send({ requisitionId: 'rq-1', supplierIds: [' '], dueOn: '2099-01-10', note: '' })).toEqual({ result: 'invalid', why: 'needSupplier' });
    expect(await s.send({ requisitionId: 'rq-1', supplierIds: ['sup-a'], dueOn: null, note: '' })).toEqual({ result: 'invalid', why: 'needDay' });
    expect(await s.send({ requisitionId: 'rq-1', supplierIds: ['sup-a'], dueOn: '10/01/2099', note: '' })).toEqual({ result: 'invalid', why: 'needDay' });
    expect(await s.send({ requisitionId: 'rq-1', supplierIds: ['sup-a'], dueOn: '2099-01-10', note: 'x'.repeat(301) })).toEqual({ result: 'invalid', why: 'noteTooLong' });
    expect(calls).toEqual([]); // nothing left the screen
    const out = await s.send({ requisitionId: 'rq-1', supplierIds: ['sup-a', 'sup-a', 'sup-b '], dueOn: '2099-01-10', note: '  per kg please ' });
    expect(out.result).toBe('ok');
    expect(calls).toEqual([{ method: 'POST', path: '/v1/purchase/requisitions/rq-1/rfq/rfq-x', body: { supplierIds: ['sup-a', 'sup-b'], dueOn: '2099-01-10', note: 'per kg please' } }]);
  });

  it('reads the register and the requisitions through head office\'s own routes; a refusal comes back in head office\'s words', async () => {
    const { calls, fetch } = stub((c) => (c.path === '/v1/purchase/rfqs' ? { status: 200, body: { rfqs: [], counts: { open: 0, overdue: 0, answered: 0 } } } : { status: 403, body: { error: { code: 'forbidden', whatHappened: 'no', wasItSaved: 'not_saved', nextSafeAction: 'ask' } } }));
    const s = createRfqSession({ viewer: buyer, fetch });
    expect((await s.register()).result).toBe('ok');
    const r = await s.requisitions();
    expect(r.result).toBe('refused');
    expect(rfqOutcomeWords('en', r)).toMatch(/^Head office refused:/);
    expect(rfqOutcomeWords('ta', r)).toMatch(/^தலைமை அலுவலகம் மறுத்தது:/);
    expect(calls.map((c) => c.path)).toEqual(['/v1/purchase/rfqs', '/v1/purchase/requisitions']);
  });

  it('adds a supplier once; the state words and tones; every word has its Tamil twin', () => {
    expect(addSupplier([], ' sup-a ')).toEqual({ ok: true, list: ['sup-a'] });
    expect(addSupplier(['sup-a'], 'sup-a')).toEqual({ ok: false, why: 'alreadyAdded' });
    expect(addSupplier(['sup-a'], '  ')).toEqual({ ok: false, why: 'needSupplier' });
    expect([rfqStateTone('open'), rfqStateTone('overdue'), rfqStateTone('answered')]).toEqual(['pending', 'error', 'ok']);
    expect(requisitionLinesText({ requisitionId: 'rq', lines: [{ productId: 'rice', quantity: 10_000, uom: 'kg' }, { productId: 'dal', quantity: 4 }] })).toBe('rice × 10.000 kg, dal × 4');
    expect(Object.keys(RFQ_COPY.ta).sort()).toEqual(Object.keys(RFQ_COPY.en).sort());
    for (const k of Object.keys(RFQ_COPY.en)) expect(rfqWords('ta', k), k).not.toBe(rfqWords('en', k));
  });

  it('head office\'s state rule: open until the day passes, overdue after it with a supplier still to answer, answered once every supplier has', () => {
    const rfq = { rfqId: 'r', requisitionId: 'q', supplierIds: ['a', 'b'], dueOn: '2026-11-10', sentBy: 'u', sentAt: '2026-11-07T10:00:00.000Z' };
    const none = [{ supplierId: 'a', answered: false }, { supplierId: 'b', answered: false }];
    const one = [{ supplierId: 'a', answered: true, quoteId: 'q1' }, { supplierId: 'b', answered: false }];
    const all = [{ supplierId: 'a', answered: true, quoteId: 'q1' }, { supplierId: 'b', answered: true, quoteId: 'q2' }];
    expect(rfqState(rfq, none, '2026-11-07')).toBe('open');
    expect(rfqState(rfq, one, '2026-11-10')).toBe('open'); // the due day itself is not yet overdue
    expect(rfqState(rfq, one, '2026-11-11')).toBe('overdue');
    expect(rfqState(rfq, all, '2026-11-11')).toBe('answered');
    expect(rfqState(rfq, [], '2026-11-11')).toBe('overdue'); // nobody asked is never "answered"
  });
});

describe('U6 · the Supplier claims session', () => {
  it('gates reading, issuing and deciding on three different rights; a decision needs a reason; the two routes are the ones that already existed', async () => {
    const { calls, fetch } = stub(() => ({ status: 201, body: { number: 'DN-000001' } }));
    const reader = createSupplierClaimsSession({ viewer: { userId: 'u-acct', permissions: ['purchase.commitment.read', 'purchase.invoice.match'] }, fetch, newKey: () => 'k' });
    expect(reader.may).toEqual({ named: true, read: true, issue: true, decide: false, credit: false, settle: false }); // U7: + credit, settle
    expect(await reader.decide({ supplierId: 's-1', submissionId: 'c-1' }, 'accept', 'fine')).toEqual({ result: 'invalid', why: 'cannotDecide' });
    const buyerS = createSupplierClaimsSession({ viewer: { userId: 'u-mgr', permissions: ['purchase.commitment.read', 'supplier.portal.review'] }, fetch, newKey: () => 'k' });
    expect(buyerS.may).toEqual({ named: true, read: true, issue: false, decide: true, credit: false, settle: true }); // U7: + credit, settle
    expect(await buyerS.issue({ supplierId: 's-1', claimId: 'dn-1' })).toEqual({ result: 'invalid', why: 'cannotIssue' });
    expect(await buyerS.decide({ supplierId: 's-1', submissionId: 'c-1' }, 'reject', '   ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(calls).toEqual([]);
    expect((await reader.issue({ supplierId: 's-1', claimId: 'dn-1' })).result).toBe('ok');
    expect((await buyerS.decide({ supplierId: 's-1', submissionId: 'c-1' }, 'reject', ' freight was in the price ')).result).toBe('ok');
    expect((await buyerS.register()).result).toBe('ok');
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/purchase/suppliers/s-1/debit-notes/dn-1/issue', body: {} },
      { method: 'POST', path: '/v1/supplier-portal/partners/s-1/submissions/c-1/review', body: { decision: 'reject', reason: 'freight was in the price' } },
      { method: 'GET', path: '/v1/purchase/supplier-claims' },
    ]);
    const cashier = createSupplierClaimsSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch });
    expect(await cashier.register()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(supplierClaimsOutcomeWords('en', { result: 'lost_link' })).toMatch(/cannot be reached/);
  });

  it('tones for every state; a supplier\'s name beside its id when known, the id alone otherwise; rupees; every word has its Tamil twin', () => {
    expect([claimStateTone('raised'), claimStateTone('issued'), claimStateTone('never_owed'), claimStateTone('pending'), claimStateTone('returned'), claimStateTone('awaiting_buyer'), claimStateTone('accepted'), claimStateTone('rejected')])
      .toEqual(['pending', 'ok', 'idle', 'pending', 'ok', 'pending', 'ok', 'error']);
    expect(supplierLabel({ supplierNames: { 's-1': 'Aavin Dairy' } }, 's-1')).toBe('Aavin Dairy (s-1)');
    expect(supplierLabel({ supplierNames: {} }, 's-2')).toBe('s-2');
    expect(rupees(123_456)).toBe('₹1,234.56');
    expect(Object.keys(SUPPLIER_CLAIMS_COPY.ta).sort()).toEqual(Object.keys(SUPPLIER_CLAIMS_COPY.en).sort());
  });
});
