import { describe, it, expect } from 'vitest';
import { shelfDaysOf, estimateStockout, shopDatesBetween, type DatedStockChange } from '../../packages/stock/src/stockout-estimate';
import { countAccuracyOf, countHistoryRows, dateRangeOf } from '../../services/inventory/src/stock-history';
import type { StoredReconciliation } from '../../services/inventory/src/counts';
import {
  createPastWriteOffsSession, createCountHistorySession, createStockoutSession, createTransferSuggestionsSession,
  STOCK_HISTORY_WORDS, failureWords, dayWords, percent, shopDateOf,
} from '../../apps/web-erp/src/stock-history-session';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';

/**
 * **Batch 20b — the stock history rules (S2 – S5) and the count review's numbers.** The empty-shelf estimate's day walk and
 * its "not known" cases (M08-FR-04 · P-08), count accuracy over a range (M09-FR-04), the date range a read takes, and the
 * four page sessions: who may read, what a refused / unreachable read says, and that "Start this transfer" carries no
 * quantity and sends nothing (P-05).
 */

const ch = (productId: string, shopDate: string, effect: 1 | -1, quantityMinor: number, isSale = false, locationId = 'S1'): DatedStockChange => ({ productId, locationId, shopDate, effect, quantityMinor, isSale });

describe('S4: what the empty shelves cost — the day walk', () => {
  it('counts a day empty only when none was on hand at its start AND nothing sold that day; days before the item came are not counted', () => {
    const changes = [
      ch('OIL', '2026-11-01', 1, 4),
      ch('OIL', '2026-11-01', -1, 2, true), ch('OIL', '2026-11-02', -1, 2, true), // sold out on the 2nd
      ch('OIL', '2026-11-05', 1, 6), // back on the 5th (that day still counts empty: none at its start, none sold)
      ch('OIL', '2026-11-06', -1, 3, true),
    ];
    const [oil] = shelfDaysOf(changes, '2026-11-01', '2026-11-07');
    // carried 1st–7th = 7 days; empty 3rd, 4th, 5th = 3; sold 7.
    expect(oil).toEqual({ productId: 'OIL', locationId: 'S1', daysCarried: 7, daysEmpty: 3, unitsSoldMinor: 7, onHandNowMinor: 3 });
    // The item first came on the 1st: a period starting in October counts only from the 1st.
    expect(shelfDaysOf(changes, '2026-10-25', '2026-11-07')[0]!.daysCarried).toBe(7);
    // What came before the period makes the opening stock.
    expect(shelfDaysOf(changes, '2026-11-03', '2026-11-07')[0]).toMatchObject({ daysCarried: 5, daysEmpty: 3, unitsSoldMinor: 3 });
    expect(shopDatesBetween('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  });

  it('only reads the places the reader may see', () => {
    const changes = [ch('OIL', '2026-11-01', 1, 1, false, 'S1'), ch('OIL', '2026-11-01', 1, 1, false, 'S2')];
    expect(shelfDaysOf(changes, '2026-11-01', '2026-11-02', (l) => l === 'S2').map((s) => s.locationId)).toEqual(['S2']);
  });

  it('estimates sales and margin lost, rounding once; says "not known" with the reason; leaves out what lost nothing', () => {
    const shelves = [
      { productId: 'OIL', locationId: 'S1', daysCarried: 7, daysEmpty: 3, unitsSoldMinor: 7, onHandNowMinor: 3 },
      // grams of a loose item: 1,500 g sold over 4 days on the shelf, 2 days empty → 750 g lost
      { productId: 'DAL', locationId: 'S1', daysCarried: 6, daysEmpty: 2, unitsSoldMinor: 1_500, onHandNowMinor: 0 },
      { productId: 'SALT', locationId: 'S1', daysCarried: 5, daysEmpty: 5, unitsSoldMinor: 0, onHandNowMinor: 0 },
      { productId: 'SOAP', locationId: 'S1', daysCarried: 5, daysEmpty: 2, unitsSoldMinor: 6, onHandNowMinor: 0 },
      { productId: 'PEN', locationId: 'S1', daysCarried: 5, daysEmpty: 0, unitsSoldMinor: 9, onHandNowMinor: 4 },
      { productId: 'IDLE', locationId: 'S1', daysCarried: 5, daysEmpty: 2, unitsSoldMinor: 0, onHandNowMinor: 0 },
      { productId: 'LOSS', locationId: 'S1', daysCarried: 5, daysEmpty: 2, unitsSoldMinor: 3, onHandNowMinor: 0 },
    ];
    const margins: Record<string, { grossMarginMinor: number; unitsSoldMinor: number }> = {
      OIL: { grossMarginMinor: 7_000, unitsSoldMinor: 7 }, // ₹10 each
      DAL: { grossMarginMinor: 3_000, unitsSoldMinor: 1_500 }, // 2 paise a gram — never rounded per gram first
      LOSS: { grossMarginMinor: -300, unitsSoldMinor: 3 },
    };
    const est = estimateStockout(shelves, (p) => margins[p]);
    const by = Object.fromEntries(est.rows.map((r) => [r.productId, r]));
    // OIL: 7 sold over 4 days on the shelf → 1.75 a day; 3 empty days → 5.25 → 5 lost; 5 × ₹10 = ₹50.
    expect(by['OIL']).toMatchObject({ daysEmpty: 3, emptyBp: 4286, normalDailyMinor: 2, lostUnitsMinor: 5, lostMarginMinor: 5_000, notKnownBecause: null });
    expect(by['DAL']).toMatchObject({ lostUnitsMinor: 750, lostMarginMinor: 1_500, notKnownBecause: null });
    expect(by['SALT']).toMatchObject({ normalDailyMinor: null, lostUnitsMinor: null, lostMarginMinor: null, notKnownBecause: 'empty_every_day' });
    expect(by['SOAP']).toMatchObject({ lostUnitsMinor: 4, lostMarginMinor: null, notKnownBecause: 'margin_not_held' });
    // No empty day, nothing sold while on the shelf, or no margin earned: nothing is claimed lost, so no row.
    expect(['PEN', 'IDLE', 'LOSS'].filter((p) => p in by)).toEqual([]);
    expect(est.rows.map((r) => r.productId)).toEqual(['OIL', 'DAL', 'SALT', 'SOAP']);
    expect([est.knownLostMarginMinor, est.notKnownCount]).toEqual([6_500, 2]);
    // An item that sold nowhere in the period: its margin cannot be stated.
    expect(estimateStockout([shelves[0]!], () => ({ grossMarginMinor: 0, unitsSoldMinor: 0 })).rows[0]!.notKnownBecause).toBe('nothing_sold_anywhere');
  });
});

const rec = (countId: string, over: Partial<StoredReconciliation> = {}): StoredReconciliation => ({
  countId, productId: 'RICE', locationId: 'S1', expectedMinor: 10, countedMinor: 10, varianceMinor: 0, valueMinor: 0, currency: 'INR', reasonCode: 'cycle_count',
  reconciled: true, adjusted: false, requiredApproval: false, counterId: 'u-1', approvedBy: null, at: '2026-11-10T05:00:00.000Z', ...over,
});

describe('S3: earlier counts and count accuracy', () => {
  it('names each count by its own number or its plan\'s; a recounted count is not listed twice; newest first', () => {
    const rows = countHistoryRows([
      rec('a', { planId: 'p1', varianceMinor: -3, countedMinor: 7, valueMinor: 300, at: '2026-11-10T05:00:00.000Z' }),
      rec('b', { planId: 'p1', recountOf: 'a', varianceMinor: -2, countedMinor: 8, valueMinor: 200, at: '2026-11-10T06:00:00.000Z' }),
      rec('c', { documentNumber: 'CNT1/26-27/00009', at: '2026-11-12T05:00:00.000Z' }),
      rec('d', { at: '2026-11-08T05:00:00.000Z', varianceMinor: 4, countedMinor: 14, valueMinor: 0, governanceFlags: ['value_unknown'] }),
    ], (p) => (p === 'p1' ? 'CNT1/26-27/00003' : undefined));
    expect(rows.map((r) => [r.countId, r.documentNumber, r.shopDate])).toEqual([
      ['c', 'CNT1/26-27/00009', '2026-11-12'], ['b', 'CNT1/26-27/00003', '2026-11-10'], ['d', null, '2026-11-08'],
    ]);
    expect(rows.find((r) => r.countId === 'd')!.valueMinor).toBeNull();
    const a = countAccuracyOf(rows);
    // 3 counts; 1 matched; units expected 30, off 6 → 80% right; ₹2 short; one difference has no value.
    expect(a).toEqual({ counts: 3, matched: 1, short: 1, over: 1, exactBp: 3333, unitsBp: 8000, shortValueMinor: 200, overValueMinor: 0, withoutValue: 1 });
    expect(countAccuracyOf([])).toMatchObject({ counts: 0, exactBp: null, unitsBp: null });
  });

  it('reads a range of shop days, defaulting to the last 30; refuses one it cannot read', () => {
    expect(dateRangeOf({}, '2026-11-20')).toEqual({ from: '2026-10-22', to: '2026-11-20' });
    expect(dateRangeOf({ from: '2026-11-01', to: '2026-11-05' }, '2026-11-20')).toEqual({ from: '2026-11-01', to: '2026-11-05' });
    for (const bad of [{ from: '2026-11-05', to: '2026-11-01' }, { from: 'yesterday' }, { from: '2025-01-01', to: '2026-11-05' }]) {
      expect(() => dateRangeOf(bad, '2026-11-20')).toThrow(/could not be read/);
    }
  });
});

/** A head office stand-in: answers by path prefix, and records what was asked. */
function fakeHttp(answers: Record<string, HttpAnswer>): HeadOfficeHttp & { asked: string[] } {
  const asked: string[] = [];
  const answer = (path: string): HttpAnswer => { asked.push(path); const k = Object.keys(answers).find((p) => path.startsWith(p)); return k === undefined ? { result: 'lost_link' } : answers[k]!; };
  return { asked, get: async (p) => answer(p), post: async (p) => answer(`POST ${p}`) };
}
const MGR = { userId: 'u-mgr', permissions: ['waste.view', 'count.view', 'inventory.availability.read'] };

describe('the four sections\' sessions', () => {
  it('S2: reads the range and the item, newest first, with the totals by kind of loss — nothing for a person without the read', async () => {
    const http = fakeHttp({ '/v1/inventory/write-offs': { result: 'ok', status: 200, body: {
      totalLossMinor: 34_000, byLossType: { expiry: { count: 1, valueMinor: 30_000 }, damage: { count: 1, valueMinor: 4_000 } },
      writeOffs: [
        { id: 'w1', documentNumber: 'WOF1/26-27/00001', productId: 'OIL', locationId: 'S1', lossType: 'expiry', qtyRemoved: 3, uom: 'ea', valueMinor: 30_000, raisedBy: 'u-mgr', approvedBy: null, at: '2026-11-08T20:00:00.000Z' },
        { id: 'w2', productId: 'OIL', locationId: 'S1', lossType: 'damage', qtyRemoved: 1, uom: 'ea', valueMinor: -4_000, valueSource: 'cost_unknown', raisedBy: 'u-mgr', approvedBy: 'u-owner', at: '2026-11-15T05:00:00.000Z' },
      ] } } });
    const s = createPastWriteOffsSession(MGR, http);
    const out = await s.read('2026-11-01', '2026-11-19', ' OIL ');
    expect(http.asked).toEqual(['/v1/inventory/write-offs?from=2026-11-01&to=2026-11-19&productId=OIL']);
    if (out.kind !== 'ok') throw new Error(out.kind);
    expect(out.value.rows.map((r) => [r.id, r.documentNumber, r.valueMinor, r.valueStated, r.shopDate])).toEqual([
      ['w2', null, 4_000, true, '2026-11-15'], ['w1', 'WOF1/26-27/00001', 30_000, false, '2026-11-09'], // 20:00 UTC is the 9th in the shop
    ]);
    expect(s.kindLines('en', out.value)).toEqual(['Expired: 1 · ₹300.00', 'Damage: 1 · ₹40.00']);
    expect(s.kindLines('ta', out.value)[0]).toMatch(/^காலாவதி: 1/);
    expect(await s.read('2026-11-19', '2026-11-01')).toEqual({ kind: 'bad_range' });
    expect(await createPastWriteOffsSession({ userId: 'u-c', permissions: [] }, http).read('2026-11-01', '2026-11-02')).toEqual({ kind: 'not_permitted' });
    expect(http.asked).toHaveLength(1); // neither a bad range nor a person without the read asks head office
  });

  it('S3: the counts and the accuracy cards — a share that cannot be stated is "Not known", never 0%', async () => {
    const http = fakeHttp({ '/v1/inventory/count-history': { result: 'ok', status: 200, body: {
      counts: [{ countId: 'c1', documentNumber: 'CNT1/26-27/00002', productId: 'RICE', locationId: 'S1', shopDate: '2026-11-10', expectedMinor: 10, countedMinor: 8, varianceMinor: -2, valueMinor: 8_000, uom: 'ea', requiredApproval: true, counterId: 'u-1', approvedBy: 'u-2' }],
      accuracy: { counts: 1, matched: 0, short: 1, over: 0, exactBp: 0, unitsBp: 8000, shortValueMinor: 8_000, overValueMinor: 0, withoutValue: 0 }, productUoms: { RICE: 'ea' },
    } } });
    const s = createCountHistorySession(MGR, http);
    const out = await s.read('2026-11-01', '2026-11-19');
    if (out.kind !== 'ok') throw new Error(out.kind);
    expect(out.value.rows[0]).toMatchObject({ documentNumber: 'CNT1/26-27/00002', varianceMinor: -2 });
    expect(s.cards('en', out.value.accuracy).map((c) => [c.label, c.value])).toEqual([
      ['Counts', '1'], ['Found exactly what the record said', '0%'], ['Units counted right', '80%'], ['Short (value)', '₹80.00'], ['Over (value)', '₹0.00'],
    ]);
    expect(s.cards('en', { ...out.value.accuracy, counts: 0, exactBp: null, unitsBp: null }).map((c) => c.value).slice(1, 3)).toEqual(['Not known', 'Not known']);
    expect(s.direction('en', out.value.rows[0]!)).toBe('Short');
    expect(s.difference('en', out.value.rows[0]!, 'ea')).toBe('−2 pieces');
    expect(s.difference('ta', { ...out.value.rows[0]!, varianceMinor: 1_250 }, 'kg')).toBe('+1.25 கிலோ');
  });

  it('S4: the estimate with its basis; "Not known" and the reason where it could not be worked out', async () => {
    const http = fakeHttp({ '/v1/inventory/stockout-estimate': { result: 'ok', status: 200, body: {
      from: '2026-10-24', to: '2026-11-20', days: 28, knownLostMarginMinor: 5_000, notKnownCount: 1, productUoms: { OIL: 'ea' },
      rows: [
        { productId: 'OIL', locationId: 'S1', daysCarried: 21, daysEmpty: 6, onHandNowMinor: 10, normalDailyMinor: 1, lostUnitsMinor: 4, lostMarginMinor: 5_000, notKnownBecause: null },
        { productId: 'DAL', locationId: 'S1', daysCarried: 6, daysEmpty: 5, onHandNowMinor: 0, normalDailyMinor: 1, lostUnitsMinor: 5, lostMarginMinor: null, notKnownBecause: 'margin_not_held' },
      ] } } });
    const s = createStockoutSession(MGR, http);
    const out = await s.read(14);
    expect(http.asked).toEqual(['/v1/inventory/stockout-estimate?days=14']);
    if (out.kind !== 'ok') throw new Error(out.kind);
    expect(s.rowWords('en', out.value.rows[0]!, 'ea')).toEqual({ daysEmpty: '6 of 21', normal: '1 piece', lostSales: '4 pieces', lostMargin: '₹50.00', why: 'Worked out', onHand: '10 pieces' });
    expect(s.rowWords('en', out.value.rows[1]!, null)).toMatchObject({ lostMargin: 'Not known', why: expect.stringMatching(/margin is not known/) });
    expect(s.rowWords('ta', out.value.rows[1]!, null).lostMargin).toBe('தெரியவில்லை');
    expect(s.cards('en', out.value).map((c) => [c.label, c.value])).toEqual([['Estimated margin lost', '₹50.00'], ['Items that could not be worked out', '1']]);
    expect(s.basis('en')).toHaveLength(4);
    expect(s.basis('en')[0]).toMatch(/none at the start of the day and nothing of it was sold that day/);
  });

  it('S5: suggestions only — "Start this transfer" fills from, to and the item, never a quantity, and sends nothing', async () => {
    const http = fakeHttp({ '/v1/inventory/transfer-suggestions': { result: 'ok', status: 200, body: { suggestionOnly: true, productUoms: {}, suggestions: [
      { productId: 'OIL', toLocationId: 'S1', fromLocationId: 'S1-BACK', fromKind: 'own_back_store', heldAtSourceMinor: 5, onHandHereMinor: 0, soldHereLast7DaysMinor: 3 },
      { productId: '', toLocationId: 'S1', fromLocationId: 'WH' },
    ] } } });
    const s = createTransferSuggestionsSession(MGR, http);
    const out = await s.read();
    if (out.kind !== 'ok') throw new Error(out.kind);
    expect(out.value.rows).toHaveLength(1);
    expect(s.whereWord('en', 'own_back_store')).toBe('This store\'s back store');
    expect(s.startForm(out.value.rows[0]!)).toEqual({ fromLocationId: 'S1-BACK', toLocationId: 'S1', productId: 'OIL', uom: '' });
    expect(http.asked.every((p) => !p.startsWith('POST'))).toBe(true);
  });

  it('a refused or unreachable read says so in plain words; nobody signed in is told', async () => {
    const lost = await createStockoutSession(MGR, fakeHttp({})).read();
    expect(failureWords('en', lost, 'tsCannot', MGR)).toMatch(/could not be reached/);
    const refused = await createCountHistorySession(MGR, fakeHttp({ '/v1/inventory/count-history': { result: 'refused', status: 403, code: 'forbidden', whatHappened: 'This account does not hold "count.view".' } })).read('2026-11-01', '2026-11-02');
    expect(failureWords('en', refused, 'chCannot', MGR)).toBe('Head office did not show it: This account does not hold "count.view".');
    expect(failureWords('ta', { kind: 'not_permitted' }, 'chCannot', undefined)).toBe(STOCK_HISTORY_WORDS.ta.nobody);
    expect(failureWords('en', { kind: 'not_permitted' }, 'chCannot', { userId: 'u', permissions: [] })).toBe(STOCK_HISTORY_WORDS.en.chCannot);
  });

  it('every English word has a Tamil twin; dates and shares are said as the shop reads them', () => {
    expect(Object.keys(STOCK_HISTORY_WORDS.ta).sort()).toEqual(Object.keys(STOCK_HISTORY_WORDS.en).sort());
    expect([dayWords('2026-11-09'), percent(9250), percent(10_000), shopDateOf('2026-11-08T20:00:00.000Z')]).toEqual(['09/11/2026', '92.5%', '100%', '2026-11-09']);
  });
});
