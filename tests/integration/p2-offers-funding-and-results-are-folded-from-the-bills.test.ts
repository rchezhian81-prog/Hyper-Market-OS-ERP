import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import { aBranch } from '../support/a-branch';
import { approvedBody } from '../support/approval-request';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

// OB-288 P2 — offers through the real routes, on the in-memory store and (with DATABASE_URL) on real PostgreSQL, with a
// cold restart reading the same answer:
//   • M05-FR-03: multibuy, the price-offer bundle (OB-306) and mix-match are defined and evaluated by the till's engine;
//     a bank-card offer cannot be defined while bank offers are off (OB-305); B15: an offer naming tobacco is refused and
//     a tobacco line takes no discount at evaluation;
//   • M05-FR-04: the supplier's funding of an offer — agreement approved by Finance, units sold FOLDED from the banked bills
//     re-judged by the engine, receipts as journals through the posting map, reconciled to the ledger to the paisa — and
//     the offer's results (units, margin at average cost, funding) against a baseline, folded, never typed.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const STORE = 'store-1';
const DAY = 86_400_000;
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const inr = (minor: number) => ({ minor, currency: 'INR' });
const HOME = { categoryId: 'home', name: 'Home care', parentId: null };

const post = (h: ApiHarness, T: string, path: string, body: unknown, userId = 'u-owner', method: 'POST' | 'PUT' = 'POST') =>
  h.request({ method, path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
const get = (h: ApiHarness, T: string, path: string, query: Record<string, string> = {}, userId = 'u-owner') =>
  h.request({ method: 'GET', path, userId, tenantId: T, query });

async function shop(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, 'u-owner');
  await aBranch(h, T, 'u-owner', STORE);
  await h.provisionRole(T, 'u-acct', 'accountant');
  await h.provisionRole(T, 'u-cash', 'cashier');
  for (const id of ['soap-a', 'soap-b', 'bread', 'jam', 'shampoo', 'conditioner']) {
    const r = await post(h, T, `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: id, baseUom: 'each', primaryCategoryId: 'home', taxClass: '3401', lifecycle: 'active' }, categories: [HOME] });
    if (r.status !== 201) throw new Error(`${id}: ${JSON.stringify(r.body)}`);
  }
  const cig = await post(h, T, '/v1/catalogue/products/cig/publish', { product: { sku: 'SKU-CIG', name: 'Cigarettes 10s', baseUom: 'each', primaryCategoryId: 'home', taxClass: '2402', lifecycle: 'draft', safety: { tobacco: true, packMinimumMinor: 10, minimumAge: 18 } }, categories: [HOME] });
  if (cig.status !== 201) throw new Error(`cig: ${JSON.stringify(cig.body)}`);
  await h.store.append(T, STREAM.catalogue, makeEvent({
    id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: iso(-10 * DAY), idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: T, version: 1, builtAt: iso(-10 * DAY), scope: { tenantId: T, storeId: STORE }, products: [{ productId: 'soap-a', sku: 'SKU-soap-a', name: 'soap-a', unitPriceMinor: 4_000, taxBps: 500, status: 'active', uom: 'each' }], barcodes: [] } },
  }));
}
const define = (h: ApiHarness, T: string, id: string, body: Record<string, unknown>) =>
  post(h, T, `/v1/promotions/${id}/definition`, { startsAt: iso(-2 * DAY), endsAt: iso(2 * DAY), ...body });
const sell = (h: ApiHarness, T: string, saleId: string, at: string, qty: number, lineTotalMinor: number) =>
  post(h, T, '/v1/sales', {
    saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay: at.slice(0, 10), committedAt: at, totalMinor: lineTotalMinor, currency: 'INR', packVersion: 1, locationId: STORE,
    lines: [{ productId: 'soap-a', quantityMinor: qty, uom: 'each', unitPriceMinor: 4_000, lineTotalMinor }], tenders: [{ kind: 'cash', amountMinor: lineTotalMinor }],
  });

describe.each(backings)('OB-288 P2 — offers, their funding and their results — on $name', ({ harness }) => {
  it('the new kinds are defined and priced by the engine; bank offers stay off; tobacco is never promoted or discounted', async () => {
    const h = harness();
    const T = randomUUID();
    await shop(h, T);
    expect((await define(h, T, 'mb-soap', { kind: 'multibuy', productIds: ['soap-a', 'soap-b'], multibuyQty: 3, multibuyPriceMinor: 9_900 })).status).toBe(201);
    expect((await define(h, T, 'set-bf', { kind: 'bundle_price', bundleItems: [{ productId: 'bread', qty: 1 }, { productId: 'jam', qty: 1 }], bundlePriceMinor: 12_000 })).status).toBe(201);
    expect((await define(h, T, 'mm-sh', { kind: 'mix_match', buyProductIds: ['shampoo'], buyQty: 1, getProductIds: ['conditioner'], getQty: 1, getPercentBps: 5_000 })).status).toBe(201);
    expect(codeOf(await define(h, T, 'mm-bad', { kind: 'mix_match', buyProductIds: ['shampoo'], buyQty: 1, getProductIds: ['shampoo'], getQty: 1, getPercentBps: 5_000 }))).toBe('not_readable_as_a_promotion');
    expect(codeOf(await define(h, T, 'mb-bad', { kind: 'multibuy', productIds: ['soap-a'], multibuyQty: 1, multibuyPriceMinor: 100 }))).toBe('not_readable_as_a_promotion');
    const bank = await define(h, T, 'bank-x', { kind: 'bank_offer', bankIssuer: 'Bank X', percentBps: 1_000 });
    expect(bank.status).toBe(422);
    expect(codeOf(bank)).toBe('bank_offers_switched_off');
    expect((bank.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/R4/);
    // B15: an offer that names tobacco — any kind — is refused by name.
    for (const [id, body] of [
      ['t1', { kind: 'percent_off', productIds: ['cig'], percentBps: 1_000 }],
      ['t2', { kind: 'bundle_price', bundleItems: [{ productId: 'cig', qty: 1 }, { productId: 'bread', qty: 1 }], bundlePriceMinor: 10_000 }],
      ['t3', { kind: 'mix_match', buyProductIds: ['bread'], buyQty: 1, getProductIds: ['cig'], getQty: 1, getPercentBps: 10_000 }],
    ] as const) {
      const r = await define(h, T, id, body);
      expect(codeOf(r), id).toBe('tobacco_may_not_be_promoted');
      expect((await get(h, T, `/v1/promotions/${id}/definition`)).status).toBe(404);
    }
    // Switch the three on (activation here, the governed launch elsewhere), then evaluate a basket.
    const wide = await define(h, T, 'wide-5', { kind: 'percent_off', percentBps: 500 });
    expect(wide.status).toBe(201);
    for (const id of ['mb-soap', 'set-bf', 'mm-sh', 'wide-5']) {
      expect((await post(h, T, `/v1/promotions/${id}/launch`, { description: id, normalPrice: inr(10_000), promoPrice: inr(9_000), unitCost: inr(5_000), baselineUnits: 100, expectedUnits: 200 })).status).toBe(201);
    }
    const line = (lineId: string, productId: string, unit: number, qty: number) => ({ lineId, productId, unitPrice: inr(unit), qty });
    const again = harness(h);
    const r = await post(again, T, '/v1/promotions/evaluate', { at: iso(0), currency: 'INR', lines: [
      line('l1', 'soap-a', 4_000, 3), line('l2', 'bread', 5_000, 1), line('l3', 'jam', 9_000, 1), line('l4', 'shampoo', 20_000, 1), line('l5', 'conditioner', 15_000, 1), line('l6', 'cig', 30_000, 1),
    ] });
    expect(r.status).toBe(200);
    const result = r.body as { discount: { minor: number }; applied: { promotionId: string }[]; perLine: { lineId: string; discountMinor: number }[] };
    expect(result.applied.map((a) => a.promotionId)).toEqual(['mb-soap', 'mm-sh', 'set-bf', 'wide-5']);
    // 5% of everything but the cigarettes: (12,000 + 5,000 + 9,000 + 20,000 + 15,000) × 5% = 3,050; plus 2,100 + 7,500 + 2,000.
    expect(result.discount.minor).toBe(2_100 + 2_000 + 7_500 + 3_050);
    expect(result.perLine.find((p) => p.lineId === 'l6')!.discountMinor).toBe(0);
  }, 120_000);

  it('the supplier\'s funding: approved by Finance, units folded from the bills by the engine, receipts as journals, reconciled; the results folded', async () => {
    const h = harness();
    const T = randomUUID();
    await shop(h, T);
    expect((await define(h, T, 'mb-soap', { kind: 'multibuy', productIds: ['soap-a'], multibuyQty: 3, multibuyPriceMinor: 9_900 })).status).toBe(201);
    expect((await post(h, T, '/v1/inventory/movements', { movementId: `rc-${randomUUID()}`, productId: 'soap-a', locationId: STORE, kind: 'received', quantityMinor: 50, unitCostMinor: 2_000, uom: 'each', occurredAt: iso(-9 * DAY), enteredBy: 'u-owner' })).status).toBe(202);
    // A baseline bill before the offer: 2 soaps at full price.
    expect((await sell(h, T, 'S0', iso(-3 * DAY), 2, 8_000)).status).toBe(202);
    expect((await post(h, T, '/v1/promotions/mb-soap/launch', { description: '3 for 99', normalPrice: inr(4_000), promoPrice: inr(3_300), unitCost: inr(2_000), baselineUnits: 2, expectedUnits: 6 })).status).toBe(201);
    // Under the offer: 3 soaps for ₹99 — and a bill of 2 that the offer did not reach.
    await new Promise((r) => setTimeout(r, 5));
    expect((await sell(h, T, 'S1', iso(0), 3, 9_900)).status).toBe(202);
    expect((await sell(h, T, 'S2', iso(0), 2, 8_000)).status).toBe(202);

    // The agreement: ₹5 a unit up to ₹100, approved by Finance in their own session. Another supplier's, unapproved.
    const terms = { perUnitMinor: 500, capMinor: 10_000 };
    expect((await post(h, T, '/v1/promotions/mb-soap/funding/sup-soap', terms, 'u-cash')).status).toBe(403);
    const body = await approvedBody(h, T, 'u-owner', 'u-acct', 'promotion_funding', 'mb-soap:sup-soap', terms, { promotionId: 'mb-soap', supplierId: 'sup-soap' }, 10_000);
    expect((await post(h, T, '/v1/promotions/mb-soap/funding/sup-soap', body)).body).toMatchObject({ approved: true, agreement: { approvedBy: 'u-acct' } });
    expect((await post(h, T, '/v1/promotions/mb-soap/funding/sup-other', { perUnitMinor: 100 })).body).toMatchObject({ approved: false });
    expect((await post(h, T, '/v1/promotions/none/funding/sup-soap', terms)).status).toBe(404);

    // Receipts: refused until the accountant maps the money; over the cap refused; then posted as a journal.
    const receipt = (id: string, amountMinor: number, who = 'u-acct') => post(h, T, `/v1/finance/promotion-funding/mb-soap/sup-soap/receipts/${id}`, { amountMinor, receivedOn: iso(0).slice(0, 10), reference: `NEFT-${id}` }, who);
    expect(codeOf(await receipt('r1', 1_500))).toBe('promotion_funding_not_mapped');
    const map = { ...DEFAULT_RETAIL_POSTING_MAP, rules: [...DEFAULT_RETAIL_POSTING_MAP.rules, { kind: 'promotion_funding', legs: [{ account: 'bank_clearing', side: 'debit', component: 'amount' }, { account: 'promotion_funding_income', side: 'credit', component: 'amount' }] }] };
    expect((await post(h, T, '/v1/finance/posting-map', map, 'u-acct', 'PUT')).status).toBe(200);
    expect((await receipt('r1', 1_500, 'u-cash')).status).toBe(403);
    expect(codeOf(await receipt('r-big', 10_001))).toBe('receipt_exceeds_funding_cap');
    expect((await receipt('r1', 1_500)).status).toBe(201);
    expect((await receipt('r1', 1_500)).body).toMatchObject({ alreadyRecorded: true });

    const again = harness(h);
    const rec = await get(again, T, '/v1/finance/promotion-funding', {}, 'u-acct');
    expect(rec.status).toBe(200);
    const lines = (rec.body as { lines: { supplierId: string; unitsSold: number; billsUnderOffer: number; earnedMinor: number; receivedMinor: number; ledgerMinor: number; outstandingMinor: number; agrees: boolean; findings: string[] }[] }).lines;
    expect(lines.find((l) => l.supplierId === 'sup-soap')).toMatchObject({ unitsSold: 3, billsUnderOffer: 1, earnedMinor: 1_500, receivedMinor: 1_500, ledgerMinor: 1_500, outstandingMinor: 0, agrees: true, findings: [] });
    expect(lines.find((l) => l.supplierId === 'sup-other')!.findings).toEqual(expect.arrayContaining(['not_approved_by_finance']));

    // The results: the offer's window against the same length just before it, folded from the bills at average cost.
    const res = await get(again, T, '/v1/promotions/mb-soap/results');
    expect(res.status).toBe(200);
    // Offer: 5 soaps, 17,900 → 17,047 ex-tax − 10,000 cost = 7,047; baseline: 2 soaps, 8,000 → 7,619 − 4,000 = 3,619; + ₹15 funding.
    expect(res.body).toMatchObject({
      measured: true, baselineChosenBy: 'same_length_just_before_the_offer', fundingReceivedMinor: 1_500,
      windows: { offer: { units: 5, netSalesMinor: 17_047, costMinor: 10_000 }, baseline: { units: 2, netSalesMinor: 7_619, costMinor: 4_000 } },
      upliftUnits: 3, incrementalMargin: { minor: 7_047 + 1_500 - 3_619 }, worthDoing: true,
    });
    expect(codeOf(await get(again, T, '/v1/promotions/mb-soap/results', { baselineFrom: '2026-01-01' }))).toBe('not_readable_as_a_baseline');
    expect((await get(again, T, '/v1/promotions/mb-soap/results', {}, 'u-cash')).status).toBe(403);
  }, 120_000);
});
