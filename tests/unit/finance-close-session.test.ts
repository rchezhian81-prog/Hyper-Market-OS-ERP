import { describe, it, expect } from 'vitest';
import { isBilingualComplete } from '../../packages/ui/src/index';
import {
  createFinanceCloseSession, outcomeOf, stockBlockers, rupees, paiseOf, sayOutcome, conflictWords, closeWords,
  FINANCE_CLOSE_COPY, FINANCE_CLOSE_COPY_KEYS, type FinanceCloseHttp, type HttpAnswer, type StockValuationView,
} from '../../apps/web-erp/src/finance-close-session';
import { createCompetitorPriceSession, gapWords, competitorOutcomeWords, COMPETITOR_COPY, COMPETITOR_COPY_KEYS, type CompetitorHttp } from '../../apps/web-erp/src/competitor-price-session';

// The Month-end page's model and the competitor-price panel's (round 12 · M23 · WF-18 · D10-FR-03/05 · D06-FR-05): what they
// send to head office, what they refuse before sending (a missing permission, an unreadable entry), and how head office's
// answers are said. The connected proofs are the browser e2es on the production API; this pins the model's own rules.

function recorder(answer: HttpAnswer = { status: 200, body: {} }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const http: FinanceCloseHttp & CompetitorHttp = {
    get: async (path) => { calls.push({ method: 'GET', path }); return answer; },
    send: async (method, path, body) => { calls.push({ method, path, body }); return answer; },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return answer; },
  };
  return { calls, http };
}
const ALL = ['finance.period.read', 'settlement.investigation.manage', 'finance.journal.post', 'finance.posting.configure', 'catalogue.pack.read'];

describe('the Month-end session', () => {
  it('speaks both languages for every word', () => {
    expect(isBilingualComplete(FINANCE_CLOSE_COPY, FINANCE_CLOSE_COPY_KEYS)).toBe(true);
    expect(isBilingualComplete(COMPETITOR_COPY, COMPETITOR_COPY_KEYS)).toBe(true);
    expect(closeWords('ta')('title')).toBe('மாத இறுதி');
  });

  it('offers and sends nothing a person\'s grants do not cover — no request leaves the page', async () => {
    const { calls, http } = recorder();
    const s = createFinanceCloseSession({ userId: 'u-cash', permissions: ['catalogue.pack.read'] }, http);
    expect(s.may).toEqual({ read: false, resolve: false, post: false, budget: false });
    expect(await s.paymentExceptions()).toEqual({ kind: 'not_allowed', needs: 'finance.period.read' });
    expect(await s.postStockAdjustment('2026-10')).toEqual({ kind: 'not_allowed', needs: 'finance.journal.post' });
    expect(await s.resolvePayment('PAY-1', { found: 'captured', amountMinor: 100, at: '2026-10-12T10:00:00Z', statementComplete: true })).toEqual({ kind: 'not_allowed', needs: 'settlement.investigation.manage' });
    expect(await s.setBudget('2026-10', [{ account: 'a', amountMinor: 1 }], '')).toEqual({ kind: 'not_allowed', needs: 'finance.posting.configure' });
    expect(await s.runDepreciation('2026-10')).toEqual({ kind: 'not_allowed', needs: 'finance.journal.post' });
    expect(calls).toEqual([]);
  });

  it('settles a payment only with the provider\'s record — the reference is the attempt the till asked under', async () => {
    const { calls, http } = recorder({ status: 201, body: { resolved: true } });
    const s = createFinanceCloseSession({ userId: 'u-acct', permissions: ALL }, http);
    await s.resolvePayment('PAY-C1', { found: 'captured', amountMinor: 64_000, at: '2026-10-12T10:00:00.000Z', statementComplete: true });
    await s.resolvePayment('PAY-C2', { found: 'nothing', amountMinor: -1, at: '', statementComplete: false });
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/finance/payment-exceptions/PAY-C1/resolve', body: { authorisations: [{ ref: 'PAY-C1', amountMinor: 64_000, status: 'captured', at: '2026-10-12T10:00:00.000Z' }], statementComplete: true } },
      { method: 'POST', path: '/v1/finance/payment-exceptions/PAY-C2/resolve', body: { authorisations: [], statementComplete: false } },
    ]);
    // An unreadable record (no amount, no time) is not sent.
    expect(await s.resolvePayment('PAY-C3', { found: 'captured', amountMinor: -1, at: '', statementComplete: true })).toEqual({ kind: 'invalid', detail: '' });
    expect(calls).toHaveLength(2);
  });

  it('sends the budget, the asset and the runs to the routes, exactly', async () => {
    const { calls, http } = recorder({ status: 201, body: {} });
    const s = createFinanceCloseSession({ userId: 'u-acct', permissions: ALL, period: '2026-10' }, http);
    expect(s.period).toBe('2026-10');
    await s.setBudget('2026-10', [{ account: ' sales_revenue ', amountMinor: 15_000 }, { account: '', amountMinor: -1 }], ' why ');
    await s.addAsset({ assetId: 'FA-1', name: 'Freezer', category: 'refrigeration', storeId: 'store-1', costMinor: 1_200_000, salvageMinor: 0, usefulLifeMonths: 12, inServiceDate: '2026-10-15' });
    await s.moveAsset('FA-1', 'store-2', '2026-10-20', 'new store');
    await s.disposeAsset('FA-1', '2026-11-01', 50_000, 'sold');
    await s.runDepreciation('2026-10');
    await s.postStockAdjustment('2026-10');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PUT /v1/finance/budgets/2026-10', 'POST /v1/finance/fixed-assets/FA-1', 'POST /v1/finance/fixed-assets/FA-1/transfer', 'POST /v1/finance/fixed-assets/FA-1/dispose',
      'POST /v1/finance/fixed-assets/depreciation/2026-10', 'POST /v1/finance/periods/2026-10/stock-adjustment',
    ]);
    expect(calls[0]!.body).toEqual({ lines: [{ account: 'sales_revenue', amountMinor: 15_000 }], reason: 'why' });
    expect(calls[1]!.body).toEqual({ name: 'Freezer', category: 'refrigeration', storeId: 'store-1', costMinor: 1_200_000, salvageMinor: 0, usefulLifeMonths: 12, inServiceDate: '2026-10-15' });
    // A month that is not a month is never sent.
    expect(await s.profitAndLoss('October')).toEqual({ kind: 'invalid', detail: '' });
    expect(calls).toHaveLength(6);
  });

  it('says head office\'s refusal in its own words; unreachable is never "done"', () => {
    const refused = outcomeOf({ status: 409, body: { error: { code: 'stock_postings_outstanding', whatHappened: '2 not in the books.', nextSafeAction: 'Post them first.' } } });
    expect(refused).toMatchObject({ kind: 'refused', status: 409, code: 'stock_postings_outstanding' });
    expect(sayOutcome('en', refused, 'ok')).toEqual({ ok: false, text: 'Head office refused: 2 not in the books. Post them first.' });
    expect(sayOutcome('ta', refused, 'ok').text).toMatch(/^தலைமை அலுவலகம் மறுத்தது: 2 not in the books\./);
    expect(sayOutcome('en', outcomeOf({ status: 0, body: null }), 'ok')).toEqual({ ok: false, text: 'Head office cannot be reached — nothing was changed.' });
    expect(sayOutcome('en', outcomeOf({ status: 201, body: {} }), 'Posted.')).toEqual({ ok: true, text: 'Posted.' });
  });

  it('names what blocks the stock adjustment — products by name, held write-offs apart, never valued at zero', () => {
    const v: StockValuationView = {
      period: '2026-10', mapped: true, posted: null, figures: null,
      outstandingStockPostings: ['count:C1', 'held_write_off:H1 (held for count plan P1)'],
      valuation: {
        closing: [], closingValueMinor: 0, negative: [], openingLoadsMinor: 0,
        unvalued: [{ productId: 'p-rice', storeId: 'store-1', onHandMinor: 5, uom: 'each', unitCostMinor: null, valueMinor: null }, { productId: 'p-x', storeId: 'store-1', onHandMinor: 1, uom: 'kg', unitCostMinor: null, valueMinor: null, name: 'Named by head office' }],
        purchases: { receivedMinor: 0, returnedToSupplierMinor: 0, purchasesMinor: 0, unvalued: ['receipt rcv-1 of p-y (no cost, no average)'] },
      },
    };
    const b = stockBlockers(v, new Map([['p-rice', 'Ponni rice 5kg']]));
    expect(b.unvaluedProducts.map((p) => p.name)).toEqual(['Ponni rice 5kg', 'Named by head office']);
    expect(b.heldWriteOffs).toEqual(['held_write_off:H1 (held for count plan P1)']);
    expect(b.outstandingPostings).toEqual(['count:C1']);
    expect(b.unvaluedReceipts).toHaveLength(1);
    expect(b.any).toBe(true);
    expect(stockBlockers({ ...v, outstandingStockPostings: [], valuation: { ...v.valuation, unvalued: [], purchases: { ...v.valuation.purchases, unvalued: [] } } }, new Map()).any).toBe(false);
    expect(stockBlockers({ ...v, mapped: false, outstandingStockPostings: [], valuation: { ...v.valuation, unvalued: [], purchases: { ...v.valuation.purchases, unvalued: [] } } }, new Map())).toMatchObject({ notMapped: true, any: true });
  });

  it('reads the products\' names only when the viewer may read the catalogue', async () => {
    const answer = (path: string): HttpAnswer => path === '/v1/catalogue/products'
      ? { status: 200, body: { products: [{ productId: 'p-rice', name: 'Ponni rice 5kg' }] } }
      : { status: 200, body: { period: '2026-10', mapped: true, posted: null, figures: null, outstandingStockPostings: [], valuation: { closing: [], closingValueMinor: 0, negative: [], openingLoadsMinor: 0, unvalued: [{ productId: 'p-rice', storeId: 's', onHandMinor: 5, uom: 'each', unitCostMinor: null, valueMinor: null }], purchases: { receivedMinor: 0, returnedToSupplierMinor: 0, purchasesMinor: 0, unvalued: [] } } } };
    const paths: string[] = [];
    const http: FinanceCloseHttp = { get: async (p) => { paths.push(p); return answer(p); }, send: async () => ({ status: 500, body: null }) };
    const owner = await createFinanceCloseSession({ permissions: ALL }, http).stockValuation('2026-10');
    expect(owner.kind === 'done' && owner.body.blockers.unvaluedProducts[0]!.name).toBe('Ponni rice 5kg');
    const acct = await createFinanceCloseSession({ permissions: ['finance.period.read'] }, http).stockValuation('2026-10');
    expect(acct.kind === 'done' && acct.body.blockers.unvaluedProducts[0]!.name).toBe('p-rice');
    expect(paths.filter((p) => p === '/v1/catalogue/products')).toHaveLength(1);
  });

  it('money in rupees from exact paise, and typed rupees into exact paise', () => {
    expect(rupees(123_456_789)).toBe('₹12,34,567.89');
    expect(rupees(-5_000)).toBe('−₹50.00');
    expect(paiseOf('110')).toBe(11_000);
    expect(paiseOf('₹1,234.5')).toBe(123_450);
    expect(paiseOf('0.07')).toBe(7);
    expect(paiseOf('12.345')).toBeNull();
    expect(paiseOf('abc')).toBeNull();
  });

  it('a conflict reads as the standing answer and the other one', () => {
    expect(conflictWords('en', { standing: { paid: true, owedToCustomerMinor: 0 }, offered: { paid: false, owedToCustomerMinor: 0, via: 'store_computer', by: 'u-box', detail: '' }, at: 'x' }))
      .toBe('Standing: Settled — the provider took the money. Another answer (store_computer, u-box) said: Settled — the provider did not take the money.');
  });
});

describe('the competitor-price panel session', () => {
  it('records a sighting with the person\'s store, exact paise and a date; never without the pricing permission', async () => {
    const { calls, http } = recorder({ status: 201, body: { changesNoPrice: true } });
    const s = createCompetitorPriceSession({ permissions: ['catalogue.pack.read', 'price.change.propose'], storeId: 'store-1', now: '2026-10-12T09:00:00.000Z', products: [{ productId: 'p-dal', name: 'Toor dal 1kg' }] }, http, () => 'obs-1');
    expect(s.nameOf('p-dal')).toBe('Toor dal 1kg');
    expect(competitorOutcomeWords('en', await s.record({ productId: 'p-dal', competitor: ' Reliance ', price: '110.50', source: 'shelf_visit' }))).toEqual({ ok: true, text: 'Recorded — head office kept the sighting. No price was changed.' });
    expect(calls).toEqual([{ method: 'POST', path: '/v1/prices/competitor/obs-1', body: { productId: 'p-dal', storeId: 'store-1', competitor: 'Reliance', priceMinor: 11_050, observedAt: '2026-10-12T09:00:00.000Z', source: 'shelf_visit' } }]);
    expect(await s.record({ productId: 'p-dal', competitor: 'X', price: 'free', source: 'phone' })).toEqual({ kind: 'invalid', detail: '' });
    const reader = createCompetitorPriceSession({ permissions: ['catalogue.pack.read'], storeId: 'store-1' }, http);
    expect(await reader.record({ productId: 'p-dal', competitor: 'X', price: '1', source: 'phone' })).toEqual({ kind: 'not_allowed', needs: 'price.change.propose' });
    await reader.compare();
    expect(calls[1]).toEqual({ method: 'GET', path: '/v1/prices/competitor?storeId=store-1' });
    expect(await createCompetitorPriceSession({ permissions: [], storeId: 'store-1' }, http).compare()).toEqual({ kind: 'not_allowed', needs: 'catalogue.pack.read' });
    expect(calls).toHaveLength(2);
  });

  it('says the gap in words — never a zero for "not known"', () => {
    expect(gapWords('en', 1_000)).toBe('we are dearer by ₹10.00');
    expect(gapWords('en', -250)).toBe('we are cheaper by ₹2.50');
    expect(gapWords('en', 0)).toBe('the same price');
    expect(gapWords('en', undefined)).toBe('our price here is not known today');
  });
});
