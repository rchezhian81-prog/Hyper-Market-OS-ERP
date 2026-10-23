import { describe, it, expect } from 'vitest';
import {
  createRequisitionsSession, offerRows, orderLinesFrom, paiseFromRupees, rupees, requisitionsWords, requisitionsOutcomeWords, REQUISITIONS_COPY,
  type ComparisonView,
} from '../../apps/web-erp/src/requisitions-session';

// M06-FR-02 · WF-03 (OB-288 P3) — the Requisitions page's DOM-free session. It asks head office and shows its answers; it
// refuses only the cheap things before a request; it never ranks quotes itself and only PROPOSES an order.

const BUYER = { userId: 'u-buyer', permissions: ['purchase.commitment.read', 'purchase.order.propose'] };
const READER = { userId: 'u-read', permissions: ['purchase.commitment.read'] };

const CMP: ComparisonView = {
  requisitionId: 'rq-1', currency: 'INR', summary: '',
  lines: [
    { productId: 'rice', quantity: 10, cheapest: { supplierId: 'sup-2', quoteId: 'q2' }, fastest: { supplierId: 'sup-1', quoteId: 'q1' }, offers: [
      { supplierId: 'sup-1', quoteId: 'q1', unitCost: { minor: 4_200 }, lineCost: { minor: 42_000 }, leadTimeDays: 2, comparable: true },
      { supplierId: 'sup-2', quoteId: 'q2', unitCost: { minor: 3_900 }, lineCost: { minor: 39_000 }, leadTimeDays: 5, comparable: true },
    ] },
    { productId: 'dal', quantity: 4, cheapest: { supplierId: 'sup-2', quoteId: 'q2' }, fastest: { supplierId: 'sup-2', quoteId: 'q2' }, offers: [
      { supplierId: 'sup-2', quoteId: 'q2', unitCost: { minor: 9_050 }, lineCost: { minor: 36_200 }, leadTimeDays: 5, comparable: true },
    ] },
  ],
  totals: [{ supplierId: 'sup-2', quoteId: 'q2', totalCost: { minor: 75_200 }, maxLeadTimeDays: 5 }],
  cheapestOverall: { supplierId: 'sup-2', quoteId: 'q2' }, incompleteQuotes: ['q1'],
};

function fakeHeadOffice(reply: (method: string, path: string, body: unknown) => { status: number; body: unknown }) {
  const calls: { method: string; path: string; body: unknown; key?: string }[] = [];
  const fetch = (async (path: string, init: RequestInit) => {
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    const key = (init.headers as Record<string, string>)['idempotency-key'];
    calls.push({ method: String(init.method), path, body, ...(key === undefined ? {} : { key }) });
    const r = reply(String(init.method), path, body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('the Requisitions page session', () => {
  it('nobody signed in, or a role without the right, sends nothing', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: {} }));
    const nobody = createRequisitionsSession({ viewer: undefined, fetch: ho.fetch });
    expect(nobody.may).toEqual({ named: false, read: false, raise: false });
    expect(await nobody.list()).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createRequisitionsSession({ viewer: READER, fetch: ho.fetch });
    expect(reader.may).toEqual({ named: true, read: true, raise: false });
    expect(await reader.raise('rq-1', [{ productId: 'rice', quantity: '10' }])).toEqual({ result: 'invalid', why: 'cannotRaise' });
    expect(await reader.recordQuote('rq-1', 'q1', 'sup-1', [])).toEqual({ result: 'invalid', why: 'cannotRaise' });
    expect(await createRequisitionsSession({ viewer: { userId: 'u-c', permissions: [] }, fetch: ho.fetch }).list()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ho.calls).toHaveLength(0);
  });

  it('raises a requisition with whole quantities only, and reads the list from head office', async () => {
    const ho = fakeHeadOffice((m, p) => m === 'GET' ? { status: 200, body: { requisitions: [{ requisitionId: 'rq-1', currency: 'INR', lines: [] }] } } : { status: 201, body: { requisition: { requisitionId: 'rq-1', currency: 'INR', lines: [{ productId: 'rice', quantity: 10 }] } } });
    const s = createRequisitionsSession({ viewer: BUYER, fetch: ho.fetch, newKey: () => 'k-1' });
    expect(await s.raise(' ', [{ productId: 'rice', quantity: '10' }])).toEqual({ result: 'invalid', why: 'needId' });
    for (const q of ['0', '1.5', 'ten', '']) expect(await s.raise('rq-1', [{ productId: 'rice', quantity: q }])).toEqual({ result: 'invalid', why: 'needLine' });
    expect(await s.raise('rq-1', [{ productId: ' ', quantity: '3' }])).toEqual({ result: 'invalid', why: 'needLine' });
    expect(ho.calls).toHaveLength(0);
    const out = await s.raise(' rq-1 ', [{ productId: ' rice ', quantity: ' 10 ' }]);
    expect(out).toMatchObject({ result: 'ok', value: { requisitionId: 'rq-1' } });
    expect(ho.calls[0]).toEqual({ method: 'POST', path: '/v1/purchase/requisitions/rq-1', body: { currency: 'INR', lines: [{ productId: 'rice', quantity: 10 }] }, key: 'k-1' });
    expect(await s.list()).toMatchObject({ result: 'ok', value: [{ requisitionId: 'rq-1' }] });
    expect(ho.calls[1]).toMatchObject({ method: 'GET', path: '/v1/purchase/requisitions' });
  });

  it('records a quote in rupees as whole paise; a bad price or day count is refused before sending', async () => {
    const ho = fakeHeadOffice(() => ({ status: 201, body: { quote: {} } }));
    const s = createRequisitionsSession({ viewer: BUYER, fetch: ho.fetch });
    expect(await s.recordQuote('rq-1', 'q1', ' ', [{ productId: 'rice', unitRupees: '42', leadDays: '2' }])).toEqual({ result: 'invalid', why: 'needSupplier' });
    expect(await s.recordQuote('rq-1', 'q1', 'sup-1', [{ productId: 'rice', unitRupees: '42.123', leadDays: '2' }])).toEqual({ result: 'invalid', why: 'needPrice' });
    expect(await s.recordQuote('rq-1', 'q1', 'sup-1', [{ productId: 'rice', unitRupees: '42', leadDays: '2.5' }])).toEqual({ result: 'invalid', why: 'needPrice' });
    expect(await s.recordQuote('rq-1', 'q1', 'sup-1', [{ productId: 'rice', unitRupees: '42', leadDays: '' }])).toEqual({ result: 'invalid', why: 'needPrice' }); // half-filled
    expect(await s.recordQuote('rq-1', 'q1', 'sup-1', [{ productId: 'rice', unitRupees: ' ', leadDays: '' }])).toEqual({ result: 'invalid', why: 'needPrice' }); // nothing quoted
    expect(ho.calls).toHaveLength(0);
    // A wholly blank line is a line the supplier did not quote: left out, so head office names the quote incomplete.
    await s.recordQuote('rq-1', 'q1', 'sup-1', [{ productId: 'rice', unitRupees: '42.5', leadDays: '2' }, { productId: 'dal', unitRupees: '', leadDays: '' }]);
    expect(ho.calls[0]).toMatchObject({ path: '/v1/purchase/requisitions/rq-1/quotes/q1', body: { supplierId: 'sup-1', lines: [{ productId: 'rice', unitCost: { minor: 4_250, currency: 'INR' }, leadTimeDays: 2 }] } });
  });

  it('marks head office\'s own cheapest and fastest; an order is raised only from a quote that covers every line', async () => {
    const rows = offerRows(CMP);
    expect(rows.map((r) => [r.productId, r.quoteId, r.cheapest, r.fastest])).toEqual([['rice', 'q1', false, true], ['rice', 'q2', true, false], ['dal', 'q2', true, true]]);
    expect(orderLinesFrom(CMP, 'q1')).toBeUndefined(); // q1 has no dal
    expect(orderLinesFrom(CMP, 'q2')).toEqual([{ productId: 'rice', orderedQty: 10, unitCost: { minor: 3_900, currency: 'INR' } }, { productId: 'dal', orderedQty: 4, unitCost: { minor: 9_050, currency: 'INR' } }]);

    const ho = fakeHeadOffice(() => ({ status: 201, body: { order: { poId: 'po-1', status: 'proposed', totalMinor: 75_200 } } }));
    const s = createRequisitionsSession({ viewer: BUYER, fetch: ho.fetch });
    const base = { requisitionId: 'rq-1', poId: 'po-1', supplierId: 'sup-2', quoteId: 'q2', deliverTo: 'store-1', comparison: CMP };
    expect(await s.raiseOrder({ ...base, quoteId: 'q1', supplierId: 'sup-1' })).toEqual({ result: 'invalid', why: 'notWholeQuote' });
    expect(await s.raiseOrder({ ...base, deliverTo: ' ' })).toEqual({ result: 'invalid', why: 'needStore' });
    expect(await s.raiseOrder({ ...base, poId: '' })).toEqual({ result: 'invalid', why: 'needId' });
    expect(ho.calls).toHaveLength(0);
    expect(await s.raiseOrder(base)).toMatchObject({ result: 'ok', value: { order: { status: 'proposed' } } });
    expect(ho.calls[0]).toMatchObject({ method: 'POST', path: '/v1/purchase/orders/po-1', body: { supplierId: 'sup-2', deliverToLocationId: 'store-1', requisitionId: 'rq-1', lines: orderLinesFrom(CMP, 'q2') } });
  });

  it('shows head office\'s refusal in its own words, and a lost link as nothing saved — never an old answer', async () => {
    const refusing = fakeHeadOffice(() => ({ status: 409, body: { error: { code: 'requisition_exists', whatHappened: 'rq-1 is already raised.' } } }));
    const out = await createRequisitionsSession({ viewer: BUYER, fetch: refusing.fetch }).raise('rq-1', [{ productId: 'rice', quantity: '1' }]);
    expect(out).toEqual({ result: 'refused', status: 409, code: 'requisition_exists', whatHappened: 'rq-1 is already raised.' });
    expect(requisitionsOutcomeWords('en', out)).toBe('Head office refused: rq-1 is already raised.');
    const down = (async () => { throw new TypeError('offline'); }) as unknown as typeof globalThis.fetch;
    const lost = await createRequisitionsSession({ viewer: BUYER, fetch: down }).list();
    expect(lost).toEqual({ result: 'lost_link' });
    expect(requisitionsOutcomeWords('ta', lost)).toBe(REQUISITIONS_COPY.ta.unreachable);
  });

  it('every English word has a Tamil twin; rupees and paise are exact', () => {
    expect(Object.keys(REQUISITIONS_COPY.ta).sort()).toEqual(Object.keys(REQUISITIONS_COPY.en).sort());
    for (const v of Object.values(REQUISITIONS_COPY.ta)) expect(v.trim()).not.toBe('');
    expect(requisitionsWords('ta', 'cheapest')).toBe('குறைந்த விலை');
    expect(paiseFromRupees('39')).toBe(3_900); expect(paiseFromRupees('39.5')).toBe(3_950); expect(paiseFromRupees('39.05')).toBe(3_905);
    expect(paiseFromRupees('-1')).toBeUndefined(); expect(paiseFromRupees('1,000')).toBeUndefined();
    expect(rupees(195_000)).toBe('₹1,950.00');
  });
});
