import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { financialYearOf, isFinancialYear, nextFinancialYear, readPublishedSeries } from '../../packages/contracts/src/receipt-number';
import { ReceiptNumbers, type PackReceiptSeries, type SeriesClock } from '../../edge/store-edge/src/receipt-numbers';
import { issuedSeriesFor, type ReceiptPrefixIssue } from '../../services/platform/src/receipt-prefixes';

/**
 * **A2 — the till's bill series is per financial year (Rule 46(b): "unique for a financial year"; addendum: "series resets
 * on FY boundary").** The year is India's (1 April – 31 March) by the bill's date in India time; the store computer
 * switches prefix at midnight IST on 1 April, offline; while the clock guard does not trust the clock it keeps the year it
 * last numbered in (§31.1 · OB-327 — the seam `seriesClock`).
 */

describe('A2 — which financial year a moment is in', () => {
  it('by the date in India time: 31 March 23:59:59 IST is the old year, 00:00 on 1 April the new', () => {
    expect(financialYearOf('2027-03-31T18:29:59.999Z')).toBe('2026-27');
    expect(financialYearOf('2027-03-31T18:30:00.000Z')).toBe('2027-28');
    expect(financialYearOf('2026-12-31T23:00:00.000Z')).toBe('2026-27');
    expect(financialYearOf('2099-04-01T00:00:00.000Z')).toBe('2099-00');
    expect(financialYearOf('not a date')).toBeUndefined();
    expect(nextFinancialYear('2026-27')).toBe('2027-28');
  });
  it('a year is written YYYY-YY with the second the year after the first; a pack line with a bad year breaks the rule', () => {
    expect(['2026-27', '2099-00'].every(isFinancialYear)).toBe(true);
    expect(['2026-28', '2026', '26-27', 2026].some(isFinancialYear)).toBe(false);
    expect(readPublishedSeries({ prefix: 'S1A26-', padTo: 6, rangeStart: 1, rangeEnd: 999_999, financialYear: '2026-28' }).ok).toBe(false);
    expect(readPublishedSeries({ prefix: 'S1A26-', padTo: 6, rangeStart: 1, rangeEnd: 999_999, financialYear: '2026-27' }).ok).toBe(true);
  });
});

describe('A2 — head office sends a year-scoped till its years, never its old yearless prefix beside them', () => {
  const at = '2026-04-01T00:00:00.000Z';
  const issues: ReceiptPrefixIssue[] = [
    { storeId: 'S1', tillId: 'lane-1', prefix: 'S1L1-', version: 1, setBy: 'u', setAt: at },
    { storeId: 'S1', tillId: 'lane-1', prefix: 'S1A26-', version: 2, setBy: 'u', setAt: at, financialYear: '2026-27' },
    { storeId: 'S1', tillId: 'lane-1', prefix: 'S1A27-', version: 3, setBy: 'u', setAt: at, financialYear: '2027-28' },
    { storeId: 'S1', tillId: 'lane-2', prefix: 'S1L2-', version: 1, setBy: 'u', setAt: at },
  ];
  it('lane-1 by year, lane-2 as before', () => {
    expect(issuedSeriesFor(issues, 'S1').map((s) => [s.laneId, s.prefix, s.financialYear ?? null])).toEqual([
      ['lane-1', 'S1A26-', '2026-27'], ['lane-1', 'S1A27-', '2027-28'], ['lane-2', 'S1L2-', null],
    ]);
  });
});

describe('A2 — the store computer\'s register switches year at midnight IST, and holds the year on a doubtful clock', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
  const SERIES: PackReceiptSeries[] = [
    { laneId: 'lane-1', prefix: 'S1A26-', padTo: 6, rangeStart: 1, rangeEnd: 999_999, bankedThrough: 0, financialYear: '2026-27' },
    { laneId: 'lane-1', prefix: 'S1A27-', padTo: 6, rangeStart: 1, rangeEnd: 999_999, bankedThrough: 0, financialYear: '2027-28' },
  ];
  const open = async (dir: string, clock: { at: string; trusted: boolean }, series: readonly PackReceiptSeries[] = SERIES) => ReceiptNumbers.open({
    dataDir: dir, capacityBytes: 10_000_000, published: () => series, now: () => clock.at,
    numbering: () => ({ storeId: 'S1', storesInBusiness: 2 }),
    seriesClock: (): SeriesClock => ({ nowIso: clock.at, trusted: clock.trusted }),
  });
  let k = 0;
  const issue = async (r: ReceiptNumbers) => { const o = await r.issue({ laneId: 'lane-1', requestKey: `rq-${k += 1}`, issuedTo: 'u-c' }); if (!o.issued) throw new Error(o.laneMessage); return o; };

  it('trusted clock: the year of the bill decides; a doubtful clock keeps the year last numbered in; trusted again, it switches; across a cold restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-a2-'));
    dirs.push(dir);
    const clock = { at: '2027-03-31T18:00:00.000Z', trusted: true };
    let r = await open(dir, clock);
    expect((await issue(r)).receiptNumber).toBe('S1A26-000001');
    // Past midnight IST — but the clock guard does not trust the clock: no switch on a doubtful clock (§31.1).
    clock.at = '2027-03-31T19:00:00.000Z';
    clock.trusted = false;
    const held = await issue(r);
    expect(held).toMatchObject({ receiptNumber: 'S1A26-000002', financialYear: '2026-27' });
    expect(r.status('lane-1')).toMatchObject({ financialYearScoped: true, financialYear: '2026-27', clockTrusted: false });
    // Trusted again: the new year, from 000001.
    clock.trusted = true;
    expect((await issue(r)).receiptNumber).toBe('S1A27-000001');
    await r.close();
    r = await open(dir, clock); // a cold restart: from the disk
    expect((await issue(r)).receiptNumber).toBe('S1A27-000002');
    expect(r.status('lane-1')).toMatchObject({ financialYearScoped: true, financialYear: '2027-28', clockTrusted: true, prefix: 'S1A27-' });
    await r.close();
  });

  it('a lane whose pack carries no year numbers as before and says it is not year-scoped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-a2-'));
    dirs.push(dir);
    const r = await open(dir, { at: '2027-04-01T06:00:00.000Z', trusted: true }, [{ laneId: 'lane-1', prefix: 'S1L1-', padTo: 6, rangeStart: 1, rangeEnd: 999_999, bankedThrough: 0 }]);
    expect((await issue(r)).receiptNumber).toBe('S1L1-000001');
    expect(r.status('lane-1')).toMatchObject({ financialYearScoped: false, clockTrusted: true });
    await r.close();
  });
});
