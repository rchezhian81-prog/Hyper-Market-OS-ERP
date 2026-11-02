import { describe, it, expect } from 'vitest';
import { createPriceChecksSession, PRICE_CHECKS_COPY, paiseOfTyped } from '../../apps/web-erp/src/price-checks-session';
import { createMarkdownSession, MARKDOWN_COPY, priceChangeLink } from '../../apps/web-erp/src/markdown-session';
import { createTobaccoWarningSession, TOBACCO_WARNING_COPY } from '../../apps/web-erp/src/tobacco-warning-session';
import { createRangeGapsSession, RANGE_GAPS_COPY, bandEdgesOf } from '../../apps/web-erp/src/range-gaps-session';

/**
 * W3 (catalogue and pricing): the tested, DOM-free sessions behind the new screen sections —
 *   • D06-FR-06 the Price mismatches page's shelf walk (record an observation, check the walk);
 *   • D06-FR-05 the Expiry page's markdown and clearance, and the competitor rule (advisory; a markdown is a price change that
 *     goes through Change a price and its second-person approval — never sent from here);
 *   • D01-FR-05 the tobacco health-warning section (record a picture, confirm one product's packs);
 *   • D02-FR-04 the range-gap report.
 * Each sends exactly what head office's route reads, refuses the cheap mistakes before sending, and offers an act only to the
 * permission head office will check again.
 */

type Answer = { status: number; body: unknown };
function fakeHeadOffice(answer: (method: string, path: string) => Answer) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const a = answer(init.method, path);
    return { ok: a.status < 300, status: a.status, json: async () => a.body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const twins = (copy: { en: Record<string, string>; ta: Record<string, string> }) => expect(Object.keys(copy.ta).sort()).toEqual(Object.keys(copy.en).sort());
const NOW = '2026-11-02T06:30:00.000Z';

describe('D06-FR-06: the shelf walk', () => {
  const AUDITOR = { userId: 'u-mgr', permissions: ['price.integrity.audit'] };
  it('every word has a Tamil twin; rupees typed are whole paise, never rounded', () => {
    twins(PRICE_CHECKS_COPY);
    expect(paiseOfTyped('45')).toBe(4_500); expect(paiseOfTyped('₹49.5')).toBe(4_950); expect(paiseOfTyped('49.555')).toBeUndefined(); expect(paiseOfTyped('45.5.0')).toBeUndefined();
  });

  it('records exactly the observation route reads — who saw it is head office\'s, never sent', async () => {
    const ho = fakeHeadOffice(() => ({ status: 201, body: { observation: { observationId: 'obs-1', branchId: 'br-1', productId: 'OIL', surface: 'shelf_label', priceMinor: 4_500, observedAt: NOW, observedBy: 'u-mgr', shelfAddress: 'A3-02' } } }));
    const s = createPriceChecksSession({ viewer: AUDITOR, fetch: ho.fetch, now: () => NOW, newObservationId: () => 'obs-1' });
    const out = await s.record({ branchId: ' br-1 ', productId: 'OIL', surface: 'shelf_label', shown: '45', shelfAddress: 'A3-02' });
    expect(out).toMatchObject({ result: 'ok', value: { observationId: 'obs-1', priceMinor: 4_500, observedBy: 'u-mgr' } });
    expect(ho.sent).toEqual([{ method: 'POST', path: '/v1/pricing/integrity/observations/obs-1', body: { branchId: 'br-1', productId: 'OIL', surface: 'shelf_label', priceMinor: 4_500, shelfAddress: 'A3-02' } }]);
  });

  it('checks the walk with head office\'s own price of record as the till price, and names a product it has none for', async () => {
    const ho = fakeHeadOffice((method, path) => {
      if (path.startsWith('/v1/prices/list/OIL/resolve')) return { status: 200, body: { priceMinor: 5_000 } };
      if (path.startsWith('/v1/prices/list/GHOST/resolve')) return { status: 404, body: { error: { code: 'not_found', whatHappened: 'no price' } } };
      return { status: 200, body: { productsChecked: 1, overchargeRisks: [{ productId: 'OIL', surface: 'shelf_label', kind: 'overcharge_risk', posPriceMinor: 5_000, displayedMinor: 4_500, differenceMinor: -500, shelfAddress: 'A3-02', detail: 'honour it' }], other: [] } };
    });
    const s = createPriceChecksSession({ viewer: AUDITOR, fetch: ho.fetch, now: () => NOW });
    const walk = [
      { observationId: 'o1', branchId: 'br-1', productId: 'OIL', surface: 'shelf_label', priceMinor: 4_500, observedAt: NOW, observedBy: 'u-mgr', shelfAddress: 'A3-02' },
      { observationId: 'o2', branchId: 'br-1', productId: 'GHOST', surface: 'app', priceMinor: 100, observedAt: NOW, observedBy: 'u-mgr' },
      { observationId: 'o3', branchId: 'br-2', productId: 'OIL', surface: 'app', priceMinor: 1, observedAt: NOW, observedBy: 'u-mgr' },
    ];
    const out = await s.check('br-1', walk);
    expect(out).toMatchObject({ result: 'ok', value: { productsChecked: 1, noPriceOfRecord: ['GHOST'], overchargeRisks: [expect.objectContaining({ productId: 'OIL', kind: 'overcharge_risk' })] } });
    expect(ho.sent.map((x) => x.method)).toEqual(['GET', 'GET', 'POST']);
    expect(ho.sent[2]).toEqual({ method: 'POST', path: '/v1/pricing/integrity/audit', body: {
      branchId: 'br-1', asAt: NOW, requiredSurfaces: [], products: [{ productId: 'OIL', name: 'OIL', posPriceMinor: 5_000 }],
      displayed: [{ surface: 'shelf_label', productId: 'OIL', branchId: 'br-1', priceMinor: 4_500, lastConfirmedAt: NOW, shelfAddress: 'A3-02' }],
    } });
  });

  it('refuses before sending: no store, no product, an unknown surface, a bad price, nothing to check; a person without the permission sends nothing', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: {} }));
    const s = createPriceChecksSession({ viewer: AUDITOR, fetch: ho.fetch });
    const r = { branchId: 'br-1', productId: 'OIL', surface: 'shelf_label', shown: '45', shelfAddress: '' };
    expect(await s.record({ ...r, branchId: '' })).toEqual({ result: 'invalid', why: 'needBranch' });
    expect(await s.record({ ...r, productId: ' ' })).toEqual({ result: 'invalid', why: 'needProduct' });
    expect(await s.record({ ...r, surface: 'pos' })).toEqual({ result: 'invalid', why: 'needSurface' });
    expect(await s.record({ ...r, shown: 'cheap' })).toEqual({ result: 'invalid', why: 'badPrice' });
    expect(await s.check('br-1', [])).toEqual({ result: 'invalid', why: 'nothingToCheck' });
    const cashier = createPriceChecksSession({ viewer: { userId: 'u-cash', permissions: ['catalogue.pack.read'] }, fetch: ho.fetch });
    expect(cashier.may.audit).toBe(false);
    expect(await cashier.record(r)).toEqual({ result: 'invalid', why: 'cannotAudit' });
    expect(await createPriceChecksSession({ viewer: undefined, fetch: ho.fetch }).record(r)).toEqual({ result: 'invalid', why: 'nobody' });
    expect(ho.sent).toHaveLength(0);
  });
});

describe('D06-FR-05: markdowns, clearance and the competitor rule', () => {
  const PROPOSER = { userId: 'u-mgr', permissions: ['price.change.propose'] };
  const OWNER = { userId: 'u-owner', permissions: ['price.change.propose', 'price.change.approve'] };
  const PROPOSAL = { productId: 'p-bread', batchId: 'B-7', remainingShelfLifeDays: 2, onHandMinor: 100, avgDailyDemandMinor: 10, projectedSalesMinor: 20, surplusMinor: 80, markdownBps: 2_500, currentPriceMinor: 5_000, newPriceMinor: 3_750, reason: 'marked_down', advisoryOnly: true };

  it('every word has a Tamil twin; the approval link opens Change a price holding the product and the price', () => {
    twins(MARKDOWN_COPY);
    expect(priceChangeLink('p-bread', 3_750)).toBe('../catalogue/?tab=price&product=p-bread&price=37.50');
  });

  it('a blank price is head office\'s own shelf price at the store; the proposal is advisory and nothing else is sent', async () => {
    const ho = fakeHeadOffice((_m, path) => (path.includes('/resolve') ? { status: 200, body: { priceMinor: 5_000 } } : { status: 200, body: { proposals: [PROPOSAL] } }));
    const s = createMarkdownSession({ viewer: PROPOSER, storeId: 'br-1', fetch: ho.fetch, now: () => NOW });
    expect(await s.propose({ productId: 'p-bread', batchId: 'B-7', daysLeft: '2', onHand: '100', price: '', rate: '10' })).toMatchObject({ result: 'ok', value: { markdownBps: 2_500, newPriceMinor: 3_750, reason: 'marked_down' } });
    expect(ho.sent).toEqual([
      { method: 'GET', path: `/v1/prices/list/p-bread/resolve?storeId=br-1&at=${encodeURIComponent(NOW)}`, body: undefined },
      { method: 'POST', path: '/v1/pricing/markdown/propose', body: { items: [{ productId: 'p-bread', batchId: 'B-7', remainingShelfLifeDays: 2, onHandMinor: 100, currentPriceMinor: 5_000, avgDailyDemand: 10 }] } },
    ]);
    expect(ho.sent.some((x) => x.path.startsWith('/v1/prices/changes'))).toBe(false);
  });

  it('a typed price is sent as typed; a blank rate is left for head office to work out from the store\'s sales', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: { proposals: [PROPOSAL] } }));
    const s = createMarkdownSession({ viewer: PROPOSER, storeId: 'br-1', fetch: ho.fetch });
    await s.propose({ productId: 'p-bread', batchId: '', daysLeft: '0', onHand: '5', price: '49.50', rate: '' });
    expect(ho.sent).toEqual([{ method: 'POST', path: '/v1/pricing/markdown/propose', body: { items: [{ productId: 'p-bread', remainingShelfLifeDays: 0, onHandMinor: 5, currentPriceMinor: 4_950 }] } }]);
  });

  it('refuses before sending; no shelf price is said, never a zero; clearance needs the store', async () => {
    const ho = fakeHeadOffice(() => ({ status: 404, body: { error: { code: 'not_found', whatHappened: 'no price' } } }));
    const s = createMarkdownSession({ viewer: PROPOSER, storeId: 'br-1', fetch: ho.fetch });
    const m = { productId: 'p-bread', batchId: '', daysLeft: '2', onHand: '100', price: '', rate: '' };
    expect(await s.propose({ ...m, productId: '' })).toEqual({ result: 'invalid', why: 'needProduct' });
    expect(await s.propose({ ...m, daysLeft: '-1' })).toEqual({ result: 'invalid', why: 'badDays' });
    expect(await s.propose({ ...m, onHand: '2.5' })).toEqual({ result: 'invalid', why: 'badQty' });
    expect(await s.propose({ ...m, rate: 'fast' })).toEqual({ result: 'invalid', why: 'badRate' });
    expect(await s.propose({ ...m, price: '1.234' })).toEqual({ result: 'invalid', why: 'badPrice' });
    expect(ho.sent).toHaveLength(0);
    expect(await s.propose(m)).toEqual({ result: 'invalid', why: 'noShelfPrice' });
    expect(ho.sent.filter((x) => x.method === 'POST')).toHaveLength(0);
    expect(await createMarkdownSession({ viewer: PROPOSER, fetch: ho.fetch }).clearance()).toEqual({ result: 'invalid', why: 'noStore' });
  });

  it('reads the clearance suggestions for the store', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: { storeId: 'br-1', asOf: '2026-11-02', suggestions: [{ ...PROPOSAL, productId: 'p-cake', batchId: 'CK-9' }], notJudged: [{ productId: 'p-jam', batchId: null, onHandMinor: 4, because: 'no_sell_by_date_known' }], advisoryOnly: true } }));
    const out = await createMarkdownSession({ viewer: PROPOSER, storeId: 'br-1', fetch: ho.fetch }).clearance();
    expect(out).toMatchObject({ result: 'ok', value: { suggestions: [expect.objectContaining({ productId: 'p-cake', batchId: 'CK-9', newPriceMinor: 3_750 })], notJudged: [{ productId: 'p-jam', batchId: null, onHandMinor: 4, because: 'no_sell_by_date_known' }] } });
    expect(ho.sent).toEqual([{ method: 'GET', path: '/v1/pricing/clearance-markdowns?storeId=br-1', body: undefined }]);
  });

  it('the competitor rule: anyone who proposes prices reads it; only who approves prices sets it — percent as basis points, with a reason', async () => {
    const ho = fakeHeadOffice((method) => (method === 'GET'
      ? { status: 200, body: { rule: { gapBps: 500, maxAgeDays: 14 }, source: 'owner_decision_OB-216', version: null, setBy: null, history: [] } }
      : { status: 201, body: { rule: { gapBps: 750, maxAgeDays: 10, version: 1 }, pricesChanged: false } }));
    const mgr = createMarkdownSession({ viewer: PROPOSER, fetch: ho.fetch });
    expect(await mgr.rule()).toMatchObject({ result: 'ok', value: { gapBps: 500, maxAgeDays: 14, source: 'owner_decision_OB-216', version: null } });
    expect(await mgr.setRule({ gapPercent: '7.5', maxAgeDays: '10', reason: 'x' })).toEqual({ result: 'invalid', why: 'cannotSetRule' });
    const owner = createMarkdownSession({ viewer: OWNER, fetch: ho.fetch });
    expect(await owner.setRule({ gapPercent: '0', maxAgeDays: '10', reason: 'x' })).toEqual({ result: 'invalid', why: 'badGap' });
    expect(await owner.setRule({ gapPercent: '7.5', maxAgeDays: '0', reason: 'x' })).toEqual({ result: 'invalid', why: 'badAge' });
    expect(await owner.setRule({ gapPercent: '7.5', maxAgeDays: '10', reason: ' ' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await owner.setRule({ gapPercent: '7.5', maxAgeDays: '10', reason: ' Shop A undercuts ' })).toEqual({ result: 'ok', value: { version: 1, alreadyInForce: false } });
    expect(ho.sent.filter((x) => x.method === 'POST')).toEqual([{ method: 'POST', path: '/v1/prices/competitor-rule', body: { gapBps: 750, maxAgeDays: 10, reason: 'Shop A undercuts' } }]);
  });

  it('a person who may not propose prices sends nothing', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: {} }));
    const s = createMarkdownSession({ viewer: { userId: 'u-cash', permissions: [] }, storeId: 'br-1', fetch: ho.fetch });
    expect(await s.propose({ productId: 'p', batchId: '', daysLeft: '1', onHand: '1', price: '1', rate: '' })).toEqual({ result: 'invalid', why: 'cannotPropose' });
    expect(await s.clearance()).toEqual({ result: 'invalid', why: 'cannotPropose' });
    expect(await s.rule()).toEqual({ result: 'invalid', why: 'cannotPropose' });
    expect(ho.sent).toHaveLength(0);
  });
});

describe('D01-FR-05: the tobacco health warning', () => {
  const OWNER = { userId: 'u-owner', permissions: ['catalogue.pack.read', 'catalogue.tobacco.picture.record', 'catalogue.tobacco.warning.confirm'] };
  const MGR = { userId: 'u-mgr', permissions: ['catalogue.pack.read', 'catalogue.tobacco.warning.confirm'] };

  it('every word has a Tamil twin', () => { twins(TOBACCO_WARNING_COPY); });

  it('reads the picture register and every tobacco product\'s standing', async () => {
    const ho = fakeHeadOffice((_m, path) => (path === '/v1/catalogue/tobacco-warning-pictures'
      ? { status: 200, body: { pictures: [{ imageId: 'P-2020', effectiveFrom: '2020-01-01', notifiedOn: '2019-10-01', reference: 'G.S.R.', evidenceRef: 'DOC', recordedBy: 'u-owner' }], inForce: { imageId: 'P-2020' }, next: null, today: '2026-11-02' } }
      : { status: 200, body: { today: '2026-11-02', products: [{ productId: 'p-cig', name: 'Cigarettes', sellable: false, standing: 'never_confirmed', picture: 'P-2020', detail: 'never confirmed' }], notSellable: 1 } }));
    const out = await createTobaccoWarningSession({ viewer: MGR, fetch: ho.fetch }).read();
    expect(out).toMatchObject({ result: 'ok', value: { inForce: 'P-2020', next: null, notSellable: 1, products: [expect.objectContaining({ productId: 'p-cig', sellable: false, standing: 'never_confirmed' })] } });
  });

  it('records a picture exactly as the route reads it, and confirms ONE product\'s packs naming the evidence', async () => {
    const ho = fakeHeadOffice((_m, path) => (path.includes('tobacco-warning-pictures') ? { status: 201, body: { productsToConfirmAgain: [] } } : { status: 201, body: { standing: { sellable: true } } }));
    const s = createTobaccoWarningSession({ viewer: OWNER, fetch: ho.fetch });
    expect(await s.recordPicture({ imageId: 'P-2020', notifiedOn: '2019-10-01', effectiveFrom: '2020-01-01', reference: ' G.S.R. 2019 ', evidenceRef: 'DOC-1' })).toEqual({ result: 'ok', value: { imageId: 'P-2020', productsToConfirmAgain: [], alreadyRecorded: false } });
    expect(await s.confirm('p-cig', 'P-2020', ' PHOTO-front ')).toEqual({ result: 'ok', value: { productId: 'p-cig', imageId: 'P-2020', sellable: true } });
    expect(ho.sent).toEqual([
      { method: 'POST', path: '/v1/catalogue/tobacco-warning-pictures/P-2020', body: { notifiedOn: '2019-10-01', effectiveFrom: '2020-01-01', reference: 'G.S.R. 2019', evidenceRef: 'DOC-1' } },
      { method: 'POST', path: '/v1/catalogue/products/p-cig/tobacco-warning-confirmation', body: { imageId: 'P-2020', evidenceRef: 'PHOTO-front' } },
    ]);
  });

  it('refuses before sending; a manager may confirm but not record a picture; a cashier may do neither', async () => {
    const ho = fakeHeadOffice(() => ({ status: 201, body: {} }));
    const owner = createTobaccoWarningSession({ viewer: OWNER, fetch: ho.fetch });
    const p = { imageId: 'P-2020', notifiedOn: '2019-10-01', effectiveFrom: '2020-01-01', reference: 'G.S.R.', evidenceRef: 'DOC' };
    expect(await owner.recordPicture({ ...p, imageId: 'GSR 2019!' })).toEqual({ result: 'invalid', why: 'badId' });
    expect(await owner.recordPicture({ ...p, effectiveFrom: '' })).toEqual({ result: 'invalid', why: 'badDate' });
    expect(await owner.recordPicture({ ...p, reference: ' ' })).toEqual({ result: 'invalid', why: 'needReference' });
    expect(await owner.recordPicture({ ...p, evidenceRef: '' })).toEqual({ result: 'invalid', why: 'needEvidence' });
    expect(await owner.confirm('p-cig', 'P-2020', ' ')).toEqual({ result: 'invalid', why: 'needEvidence' });
    expect(await owner.confirm('p-cig', '', 'PHOTO')).toEqual({ result: 'invalid', why: 'needPicture' });
    const mgr = createTobaccoWarningSession({ viewer: MGR, fetch: ho.fetch });
    expect(mgr.may).toEqual({ named: true, read: true, record: false, confirm: true });
    expect(await mgr.recordPicture(p)).toEqual({ result: 'invalid', why: 'cannotRecord' });
    const cashier = createTobaccoWarningSession({ viewer: { userId: 'u-cash', permissions: ['catalogue.pack.read'] }, fetch: ho.fetch });
    expect(await cashier.confirm('p-cig', 'P-2020', 'PHOTO')).toEqual({ result: 'invalid', why: 'cannotConfirm' });
    expect(ho.sent).toHaveLength(0);
  });
});

describe('D02-FR-04: the range-gap report', () => {
  const READER = { userId: 'u-mgr', permissions: ['merchandising.range.read'] };

  it('every word has a Tamil twin; band edges are typed in rupees, rising; blank is one band', () => {
    twins(RANGE_GAPS_COPY);
    expect(bandEdgesOf('50, 200')).toEqual([5_000, 20_000]); expect(bandEdgesOf('')).toEqual([]);
    expect(bandEdgesOf('200, 50')).toBeUndefined(); expect(bandEdgesOf('cheap')).toBeUndefined(); expect(bandEdgesOf('0')).toBeUndefined();
  });

  it('asks for exactly the window and the bands, and keeps a margin head office could not work out as not known', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: {
      from: '2026-11-01', to: '2026-11-02', bands: ['under ₹50', '₹50 to ₹200', '₹200 and above'], bandsChosenBy: 'the_reader',
      gaps: [{ categoryId: 'staples', band: '₹50 to ₹200', shortPicks: 1, shortPickedQuantityMinor: 2, failedSubstitutions: 1, products: ['oil-1l'] }],
      searchesWithNoResult: [{ words: 'cold pressed groundnut oil', count: 2 }],
      privateLabel: [{ categoryId: 'staples', privateLabel: { netSalesMinor: 10_000, marginMinor: 3_000, marginBps: 3_000, products: 1, costNotKnownFor: [] }, branded: { netSalesMinor: 20_000, marginMinor: null, marginBps: null, products: 1, costNotKnownFor: ['brand-rice'] } }],
      privateLabelProducts: 1, totals: { shortPicks: 1, failedSubstitutions: 1, searchesWithNoResult: 2 },
    } }));
    const out = await createRangeGapsSession({ viewer: READER, fetch: ho.fetch }).read({ from: '2026-11-01', to: '2026-11-02', bands: '50, 200' });
    expect(out).toMatchObject({ result: 'ok', value: { gaps: [expect.objectContaining({ categoryId: 'staples', shortPicks: 1 })], searches: [{ words: 'cold pressed groundnut oil', count: 2 }], privateLabel: [{ own: expect.objectContaining({ marginBps: 3_000 }), branded: expect.objectContaining({ marginBps: null, costNotKnownFor: ['brand-rice'] }) }] } });
    expect(ho.sent).toEqual([{ method: 'GET', path: '/v1/merchandising/range-gaps?from=2026-11-01&to=2026-11-02&bandEdgesMinor=5000,20000', body: undefined }]);
  });

  it('refuses before sending: a backwards window, falling bands; a person without the permission reads nothing', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: {} }));
    const s = createRangeGapsSession({ viewer: READER, fetch: ho.fetch });
    expect(await s.read({ from: '2026-11-02', to: '2026-11-01', bands: '' })).toEqual({ result: 'invalid', why: 'badDates' });
    expect(await s.read({ from: '2026-11-01', to: '2026-11-02', bands: '200, 50' })).toEqual({ result: 'invalid', why: 'badBands' });
    expect(await createRangeGapsSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch: ho.fetch }).read({ from: '2026-11-01', to: '2026-11-01', bands: '' })).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ho.sent).toHaveLength(0);
  });
});
