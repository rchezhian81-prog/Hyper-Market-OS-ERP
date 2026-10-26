import { describe, it, expect } from 'vitest';
import { createScorecardSession, signedRupees, costWords, notComparedWords, scorecardWords, SCORECARD_COPY } from '../../apps/web-erp/src/supplier-scorecard-session';

// FG-4 · D03-FR-05: the Supplier scorecard page's price-variance part. It asks head office only with the read permission, a
// supplier and a forward period; a drill-through asks the same with the product or receipt behind the row; the money is
// said with its sign; a line that was not compared is said by its reason; every word has a Tamil twin.

const recorder = () => {
  const calls: string[] = [];
  const fetch = (async (url: string) => { calls.push(url); return new Response(JSON.stringify({ lines: [] }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

describe('Supplier price-variance session (D03-FR-05)', () => {
  it('asks only with purchase.commitment.read, a supplier and a forward period; a drill names the row', async () => {
    const r = recorder();
    const s = createScorecardSession({ viewer: { userId: 'u', permissions: ['purchase.commitment.read'] }, fetch: r.fetch });
    expect(await s.priceVariance(' ', '', '')).toEqual({ result: 'invalid', why: 'needSupplier' });
    expect(await s.priceVariance('s-1', '2026-09-30', '2026-09-01')).toEqual({ result: 'invalid', why: 'backwards' });
    expect((await s.priceVariance('s-1', '2026-09-01', '2026-09-30')).result).toBe('ok');
    expect((await s.priceVariance('s-1', '', '', { productId: 'rice 5kg' })).result).toBe('ok');
    expect((await s.priceVariance('s-1', '', '', { grnId: 'grn-1' })).result).toBe('ok');
    expect(r.calls).toEqual([
      '/v1/purchase/price-variance?supplierId=s-1&from=2026-09-01&to=2026-09-30',
      '/v1/purchase/price-variance?supplierId=s-1&productId=rice+5kg',
      '/v1/purchase/price-variance?supplierId=s-1&grnId=grn-1',
    ]);
    const none = createScorecardSession({ viewer: { userId: 'u', permissions: [] }, fetch: r.fetch });
    expect(await none.priceVariance('s-1', '', '')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createScorecardSession({ viewer: undefined, fetch: r.fetch }).priceVariance('s-1', '', '')).toEqual({ result: 'invalid', why: 'nobody' });
  });

  it('a refusal is head office\'s words; a lost link is said, never an old figure', async () => {
    const refused = (async () => new Response(JSON.stringify({ error: { code: 'forbidden', whatHappened: 'no' } }), { status: 403 })) as unknown as typeof globalThis.fetch;
    expect(await createScorecardSession({ viewer: { userId: 'u', permissions: ['purchase.commitment.read'] }, fetch: refused }).priceVariance('s', '', '')).toEqual({ result: 'refused', status: 403, code: 'forbidden', whatHappened: 'no' });
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
    expect(await createScorecardSession({ viewer: { userId: 'u', permissions: ['purchase.commitment.read'] }, fetch: down }).priceVariance('s', '', '')).toEqual({ result: 'lost_link' });
  });

  it('money with its sign, case costs exactly, the not-compared reasons in words, a Tamil twin for every word', () => {
    expect([signedRupees(2_000), signedRupees(-400), signedRupees(0)]).toEqual(['+₹20.00', '−₹4.00', '₹0.00']);
    expect([costWords({ minor: 5_200 }), costWords({ minor: 25_000, per: 24 })]).toEqual(['₹52.00', '₹250.00 / 24']);
    expect(notComparedWords('en', { no_purchase_order: 0, product_not_on_order: 2 })).toBe('Not compared: 2 — product not on the order');
    expect(notComparedWords('en', { no_purchase_order: 0 })).toBe('');
    expect(scorecardWords('ta', 'ppvTitle')).toBe('கொள்முதல் விலை மாறுபாடு');
    expect(Object.keys(SCORECARD_COPY.ta).sort()).toEqual(Object.keys(SCORECARD_COPY.en).sort());
  });
});
