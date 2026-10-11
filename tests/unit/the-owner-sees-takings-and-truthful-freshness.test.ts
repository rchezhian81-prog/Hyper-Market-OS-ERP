import { describe, it, expect } from 'vitest';
import { buildBrief, type BuildBriefInput } from '../../apps/owner-app/src/index';
import type { SaleFact } from '../../packages/reporting/src/index';
import { figure } from '../../services/reporting/src/index';
import { nothingUnsentAtFor } from '../../services/api/src/report-producers';

/**
 * **Round 4 acceptance — found by the final store journey and fixed (P-08 · M29).** The connected proof is
 * `tests/integration/store-acceptance-journey.test.ts` (real PostgreSQL + the real store computer); these pin the rules.
 *
 *   1. The owner's Today never says "No sales recorded" while the till took money: bills the store computer cannot cost are
 *      shown as takings, with the margin said to be "not known" (which cost to use is an owner decision, not made here).
 *   2. An old figure from a store that has since said it holds NOTHING unsent is old because nothing new happened — said so,
 *      instead of "wait for the sync"; a store that still holds work (or never said) keeps the warning.
 */

const ASOF = '2026-10-10T20:00:00Z';
const SYNCED = '2026-10-10T19:59:00Z';
const costed = (id: string): SaleFact => ({ saleId: id, netMinor: 10_000, taxMinor: 500, totalMinor: 10_500, cogsMinor: 7_000, units: 1, tender: 'cash', currency: 'INR' });
const base = (over: Partial<BuildBriefInput> = {}): BuildBriefInput => ({ asOf: ASOF, lastSyncedAt: SYNCED, staleAfterSeconds: 300, sales: [], exceptions: [], approvals: [], ...over });

describe('the owner\'s Today shows takings it cannot cost', () => {
  it('no costed bill, 3 uncosted: the takings and tenders are shown and the margin is "not known" — never "No sales"', () => {
    const b = buildBrief(base({ uncosted: { bills: 3, takenMinor: 198_000, tenderMix: { cash: 117_100, card: 30_000, upi: 50_000, loyalty_points: 900 } } }));
    expect(b.headline).toBe('3 bills today, ₹1,980.00 taken — margin not known: the store computer has no cost for products on these bills.');
    expect(b.takings).toEqual({ bills: 3, takenMinor: 198_000, marginUnknownBills: 3, tenderMix: { cash: 117_100, card: 30_000, upi: 50_000, loyalty_points: 900 } });
    expect(b.kpis.basketCount).toBe(0); // the costed figures stay the costed ones
  });

  it('costed and uncosted together: the margin is over the costed bills, and the rest is said beside it', () => {
    const b = buildBrief(base({ sales: [costed('s1')], uncosted: { bills: 1, takenMinor: 4_000, tenderMix: { cash: 4_000 } } }));
    expect(b.headline).toMatch(/^1 bill today, ₹105\.00 taken, margin ₹30\.00 .* Also 1 bill \(₹40\.00\) whose margin is not known — products with no cost\.$/);
    expect(b.takings).toEqual({ bills: 2, takenMinor: 14_500, marginUnknownBills: 1, tenderMix: { cash: 14_500 } });
  });

  it('a day with nothing at all is still "No sales recorded yet today"', () => {
    expect(buildBrief(base()).headline).toBe('No sales recorded yet today.');
    expect(buildBrief(base({ uncosted: { bills: 0, takenMinor: 0, tenderMix: {} } })).takings).toEqual({ bills: 0, takenMinor: 0, marginUnknownBills: 0, tenderMix: {} });
  });
});

describe('an old figure says WHY it is old', () => {
  const now = '2026-10-11T00:05:00.000Z';
  const lastSale = '2026-10-10T14:00:00.000Z';

  it('stale with the store saying "nothing unsent" after its last sale: old because nothing newer happened', () => {
    const f = figure({ name: 'Taken', valueMinor: 198_000, unit: 'minor_currency', asAt: lastSale, now, nothingUnsentAt: '2026-10-11T00:04:00.000Z' });
    expect(f.staleness).toBe('stale');
    expect(f.detail).toMatch(/old because nothing newer happened: the store computer said at 2026-10-11T00:04:00.000Z it had nothing waiting to send/);
    expect(f.detail).not.toMatch(/until the sync recovers/);
  });

  it('no such word, or a word from before the last sale: the warning stays', () => {
    expect(figure({ name: 'Taken', valueMinor: 1, unit: 'minor_currency', asAt: lastSale, now }).detail).toMatch(/until the sync recovers/);
    expect(figure({ name: 'Taken', valueMinor: 1, unit: 'minor_currency', asAt: lastSale, now, nothingUnsentAt: '2026-10-10T13:00:00.000Z' }).detail).toMatch(/until the sync recovers/);
  });

  it('every sales source must vouch: a store still holding work, a store that never reported, or a lane source keeps the warning', () => {
    const report = (storeId: string, unsentItems: number | undefined, reportedAt: string) => [storeId, { storeId, catalogueVersion: 1, storePackVersion: 1, reportedBy: 'u-box', reportedAt, ...(unsentItems === undefined ? {} : { unsentItems }) }] as const;
    const reports = new Map([report('S1', 0, '2026-10-11T00:04:00.000Z'), report('S2', 2, '2026-10-11T00:04:00.000Z'), report('S3', undefined, '2026-10-11T00:04:00.000Z')]);
    expect(nothingUnsentAtFor(reports, [{ source: 'store:S1', lastEventAt: lastSale }])).toBe('2026-10-11T00:04:00.000Z');
    expect(nothingUnsentAtFor(reports, [{ source: 'store:S1', lastEventAt: lastSale }, { source: 'store:S2', lastEventAt: lastSale }])).toBeUndefined();
    expect(nothingUnsentAtFor(reports, [{ source: 'store:S3', lastEventAt: lastSale }])).toBeUndefined();
    expect(nothingUnsentAtFor(reports, [{ source: 'store:S9', lastEventAt: lastSale }])).toBeUndefined();
    expect(nothingUnsentAtFor(reports, [{ source: 'lane:lane-1', lastEventAt: lastSale }])).toBeUndefined();
    expect(nothingUnsentAtFor(reports, [{ source: 'store:S1', lastEventAt: '2026-10-11T00:05:00.000Z' }])).toBeUndefined(); // a sale after the word
  });
});
