import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import type { TradingCalendar } from '../../packages/calendar/src/trading-day';
import { financialYearOf } from '../../packages/contracts/src/receipt-number';
import { ReceiptNumbers, type PackReceiptSeries } from '../../edge/store-edge/src/receipt-numbers';
import { receiptPrefixRoutes } from '../../services/platform/src/receipt-prefixes';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { expiryStateAdapter, shopDateOf } from '../../services/api/src/lane2-offline-adapters';
import { tallyOutboxAdapter, rebateAccrualAdapter } from '../../services/api/src/finance-bridge-adapters';
import { lpCorrelationAdapter, supplierFactsFor } from '../../services/api/src/r4-supply-lp-adapters';
import { onShelfAvailabilityAdapter } from '../../services/api/src/r3-ops-adapters';
import { opsMessagingRoutes } from '../../services/api/src/ops-messaging-adapters';
import type { RequestContext } from '../../services/kernel/src/index';

/**
 * **M01-FR-02 · OB-336 (re-audit final, package T1): the last places that dated by a fixed +05:30 read the shop's own
 * calendar.** Four files (lane2-offline-adapters, r3-ops-adapters, r4-supply-lp-adapters and the bill-number year in
 * receipt-number) took a moment's day as "UTC plus five and a half hours". That is right only for a shop in India whose
 * trading day ends at midnight. Store setup lets the owner set the cut-off (OB-336) and the zone, so these now read the
 * tenant's calendar (packages/calendar/src/shop-clock.ts):
 *   - a TRADING day (the Tally day file, a rebate accrual's journal date, the loss-prevention days that line up with the
 *     sales) takes the zone AND the cut-off — at 01:30 with a 02:00 cut-off it is still yesterday;
 *   - a CALENDAR date (a best-before date's "expired today", a received-on date, a bill's printed date and so its
 *     financial year) takes the zone only — the cut-off does not move what the paper says.
 * Each check below fails on the old fixed-offset code.
 */

const IST_0200: TradingCalendar = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '02:00' };
const DUBAI: TradingCalendar = { timeZone: 'Asia/Dubai', tradingDayCutoff: '00:00' };
const DUBAI_0200: TradingCalendar = { timeZone: 'Asia/Dubai', tradingDayCutoff: '02:00' };
/** 01:30 IST on 2 November 2026. */
const AT_0130_IST = '2026-11-01T20:00:00.000Z';
/** 00:30 IST on 2 November — but still 23:00 on 1 November in Dubai. */
const AT_0030_IST = '2026-11-01T19:00:00.000Z';
const T = 'sre';
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({ tenantId: T, userId: 'owner-1', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });

describe('T1 — no fixed +05:30 is left in the four files', () => {
  it('none of them adds a fixed offset to a moment any more', () => {
    for (const f of ['services/api/src/lane2-offline-adapters.ts', 'services/api/src/r3-ops-adapters.ts', 'services/api/src/r4-supply-lp-adapters.ts', 'packages/contracts/src/receipt-number.ts']) {
      const src = readFileSync(resolve(__dirname, '../..', f), 'utf8');
      expect(src, f).not.toMatch(/IST_OFFSET|330 \* 60_000|5\.5 \* 3_600_000/);
    }
  });
});

describe('T1 — trading days take the shop\'s cut-off (01:30 with a 02:00 cut-off is still yesterday)', () => {
  it('the Tally day file\'s "today" and a rebate accrual\'s journal date', async () => {
    const store = new InMemoryEventStore();
    const now = () => AT_0130_IST;
    expect(await tallyOutboxAdapter({ store, now, calendar: () => IST_0200 }).shopDayOf(AT_0130_IST, T)).toBe('2026-11-01');
    expect(await rebateAccrualAdapter({ store, now, calendar: () => IST_0200 }).shopDayOf(AT_0130_IST, T)).toBe('2026-11-01');
    // With the shop's midnight cut-off it is the 2nd, as before.
    expect(await tallyOutboxAdapter({ store, now }).shopDayOf(AT_0130_IST, T)).toBe('2026-11-02');
  });

  it('the loss-prevention view puts a refund, a till activity, a write-off and a count difference at 01:30 on the trading day they belong to', async () => {
    const store = new InMemoryEventStore();
    const now = () => AT_0130_IST;
    await store.append(T, streamName(STREAM.lossPrevention, 'activity'), makeEvent({
      id: 'act-1', type: 'TillActivityRecorded', occurredAt: AT_0130_IST, idempotencyKey: 'act-1', source: 'test',
      payload: { activityId: 'a1', kind: 'no_sale', laneId: 'lane-1', cashierId: 'c1', valueMinor: 0, at: AT_0130_IST, reason: 'change' },
    }));
    await store.append(T, STREAM.returns, makeEvent({
      id: 'ret-1', type: 'ReturnRecorded', occurredAt: AT_0130_IST, idempotencyKey: 'ret-1', source: 'test',
      payload: { returnId: 'r1', processedAt: AT_0130_IST, processedBy: 'c1', refundMinor: 5000, reasonCode: 'damaged', lines: [{ productId: 'p1' }] },
    }));
    await store.append(T, streamName(STREAM.inventory, 'write-offs'), makeEvent({
      id: 'wo-1', type: 'WriteOffCommitted', occurredAt: AT_0130_IST, idempotencyKey: 'wo-1', source: 'test',
      payload: { id: 'w1', productId: 'p1', lossType: 'damage', reasonCode: 'broken', qtyRemoved: 1000, valueMinor: 4000, at: AT_0130_IST },
    }));
    await store.append(T, streamName(STREAM.inventory, 'counts'), makeEvent({
      id: 'cnt-1', type: 'CountReconciled', occurredAt: AT_0130_IST, idempotencyKey: 'cnt-1', source: 'test',
      payload: { countId: 'k1', productId: 'p1', varianceMinor: -1000, valueMinor: -4000, at: AT_0130_IST },
    }));
    const lp = lpCorrelationAdapter({ store, now, calendar: () => IST_0200 });
    const till = await lp.tillExceptions(T, '2026-11-01', '2026-11-01');
    expect(till.map((x) => [x.ref, x.day])).toEqual([['till-activity:a1', '2026-11-01'], ['return:r1', '2026-11-01']]);
    expect((await lp.shrink(T, '2026-11-01', '2026-11-01')).map((x) => x.day)).toEqual(['2026-11-01']);
    expect((await lp.countDifferences(T, '2026-11-01', '2026-11-01')).map((x) => x.day)).toEqual(['2026-11-01']);
    // Nothing of it lands on the 2nd, which has not begun trading.
    expect(await lp.tillExceptions(T, '2026-11-02', '2026-11-02')).toEqual([]);
  });
});

describe('T1 — calendar dates take the shop\'s zone, and the cut-off does not move them', () => {
  it('the expiry sweep\'s day: a batch is judged by the date in the shop, wherever the shop is', async () => {
    const store = new InMemoryEventStore();
    const now = () => AT_0030_IST;
    expect(await expiryStateAdapter({ store, now }).shopDayOf(AT_0030_IST, T)).toBe('2026-11-02');
    expect(await expiryStateAdapter({ store, now, calendar: () => DUBAI }).shopDayOf(AT_0030_IST, T)).toBe('2026-11-01');
    // A best-before date is a calendar date: a later cut-off does not keep an expired batch on sale.
    expect(await expiryStateAdapter({ store, now, calendar: () => IST_0200 }).shopDayOf(AT_0130_IST, T)).toBe('2026-11-02');
    expect(await shopDateOf(() => DUBAI_0200)(AT_0130_IST, T)).toBe('2026-11-02');
  });

  it('a product\'s first receipt day and the supplier scorecard\'s dates are the shop\'s calendar dates', async () => {
    const store = new InMemoryEventStore();
    const now = () => AT_0030_IST;
    await store.append(T, STREAM.inventory, makeEvent({
      id: 'mv-1', type: 'InventoryMoved', occurredAt: AT_0030_IST, idempotencyKey: 'mv-1', source: 'test',
      payload: { productId: 'p1', locationId: 'L1', kind: 'received', occurredAt: AT_0030_IST, quantityMinor: 1000 },
    }));
    const firstReceipts = onShelfAvailabilityAdapter({ store, now, calendar: () => DUBAI }).firstReceipts!;
    expect(await firstReceipts(T)).toEqual([{ productId: 'p1', locationId: 'L1', firstReceiptDay: '2026-11-01' }]);
    expect(await onShelfAvailabilityAdapter({ store, now }).firstReceipts!(T)).toEqual([{ productId: 'p1', locationId: 'L1', firstReceiptDay: '2026-11-02' }]);
    expect((await supplierFactsFor({ store, now, calendar: () => DUBAI })(T, 'sup-1')).today).toBe('2026-11-01');
    expect((await supplierFactsFor({ store, now })(T, 'sup-1')).today).toBe('2026-11-02');
  });

  it('the capacity report\'s busiest hour is an hour on the shop\'s clock', async () => {
    const store = new InMemoryEventStore();
    const now = () => '2026-11-02T12:00:00.000Z';
    // 10:10 and 10:40 UTC: 15:40 and 16:10 in India (two hours), 14:10 and 14:40 in Dubai (one hour).
    for (const [id, at] of [['s1', '2026-11-01T10:10:00.000Z'], ['s2', '2026-11-01T10:40:00.000Z']] as const) {
      await store.append(T, STREAM.sales, makeEvent({
        id, type: 'SaleCommitted', occurredAt: at, idempotencyKey: id, source: 'test',
        payload: { saleId: id, laneId: 'lane-1', tradingDay: '2026-11-01', committedAt: at, lines: [] },
      }));
    }
    const peakHour = async (calendar?: () => TradingCalendar) => {
      const route = opsMessagingRoutes({ store, now, ...(calendar === undefined ? {} : { calendar }) }).find((r) => r.method === 'GET' && r.path === '/v1/platform/capacity-report')!;
      const res = await route.handler(ctx());
      const rows = (res.body as { rows: { measure: string; measuredPeak: number | null }[] }).rows;
      const row = rows.find((r) => r.measure === 'bills_per_peak_hour')!;
      return row.measuredPeak;
    };
    expect(await peakHour()).toBe(1);
    expect(await peakHour(() => DUBAI)).toBe(2);
  });
});

describe('T1 — the bill number\'s financial year is its printed date in the shop\'s zone; nothing already issued changes', () => {
  it('for the shop default (India) every moment around the year end is in the same year as before', () => {
    // The old rule, kept here only as the yardstick: UTC + 05:30, April onwards is the new year.
    const old = (iso: string): string => { const d = new Date(Date.parse(iso) + 330 * 60_000); const y = d.getUTCFullYear(); const s = d.getUTCMonth() >= 3 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
    const from = Date.parse('2027-03-31T12:00:00.000Z');
    for (let m = 0; m <= 24 * 60; m += 7) {
      const iso = new Date(from + m * 60_000).toISOString();
      expect(financialYearOf(iso), iso).toBe(old(iso));
      expect(financialYearOf(iso, 'Asia/Kolkata'), iso).toBe(old(iso));
    }
  });

  it('a shop in another zone numbers by its own date: 23:00 on 31 March in Dubai is still the old year', () => {
    const at = '2027-03-31T19:00:00.000Z'; // 00:30 IST on 1 April; 23:00 in Dubai on 31 March
    expect(financialYearOf(at)).toBe('2027-28');
    expect(financialYearOf(at, 'Asia/Dubai')).toBe('2026-27');
    expect(financialYearOf('2027-03-31T20:00:00.000Z', 'Asia/Dubai')).toBe('2027-28');
    expect(financialYearOf('not a date', 'Asia/Dubai')).toBeUndefined();
  });

  describe('the store computer\'s register', () => {
    const dirs: string[] = [];
    afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
    const SERIES: PackReceiptSeries[] = [
      { laneId: 'lane-1', prefix: 'S1A26-', padTo: 6, rangeStart: 1, rangeEnd: 999_999, bankedThrough: 0, financialYear: '2026-27' },
      { laneId: 'lane-1', prefix: 'S1A27-', padTo: 6, rangeStart: 1, rangeEnd: 999_999, bankedThrough: 0, financialYear: '2027-28' },
    ];
    let k = 0;
    const open = (dir: string, clock: { at: string }, zone?: () => string) => ReceiptNumbers.open({
      dataDir: dir, capacityBytes: 10_000_000, published: () => SERIES, now: () => clock.at,
      numbering: () => ({ storeId: 'S1', storesInBusiness: 2 }), ...(zone === undefined ? {} : { timeZone: zone }),
    });
    const issue = async (r: ReceiptNumbers) => { const o = await r.issue({ laneId: 'lane-1', requestKey: `t1-${k += 1}`, issuedTo: 'u-c' }); if (!o.issued) throw new Error(o.laneMessage); return o.receiptNumber; };

    it('numbers in the year of the shop\'s own date, one series per year, unique and with no gap — and a restart changes nothing issued', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sre-t1-'));
      dirs.push(dir);
      const clock = { at: '2027-03-31T18:00:00.000Z' }; // 22:00 Dubai
      let r = await open(dir, clock, () => 'Asia/Dubai');
      expect(await issue(r)).toBe('S1A26-000001');
      clock.at = '2027-03-31T19:00:00.000Z'; // 00:30 IST — the old code moved to the new year here; in Dubai it is 23:00
      expect(await issue(r)).toBe('S1A26-000002');
      clock.at = '2027-03-31T20:00:00.000Z'; // 00:00 Dubai on 1 April
      expect(await issue(r)).toBe('S1A27-000001');
      await r.close();
      r = await open(dir, clock, () => 'Asia/Dubai'); // cold restart from the disk
      expect(await issue(r)).toBe('S1A27-000002');
      await r.close();
    });

    it('with no zone, or a zone this machine cannot read, the shop default (India) — exactly as before', async () => {
      for (const zone of [undefined, () => 'Not/AZone']) {
        const dir = await mkdtemp(join(tmpdir(), 'sre-t1-'));
        dirs.push(dir);
        const clock = { at: '2027-03-31T18:29:00.000Z' };
        const r = await open(dir, clock, zone);
        expect(await issue(r)).toBe('S1A26-000001');
        clock.at = '2027-03-31T18:30:00.000Z'; // 00:00 IST on 1 April
        expect(await issue(r)).toBe('S1A27-000001');
        await r.close();
      }
    });
  });

  it('head office\'s "this year" for the prefixes page is the shop\'s year', async () => {
    const route = (calendar?: () => TradingCalendar) => receiptPrefixRoutes({
      now: () => '2027-03-31T19:00:00.000Z', stores: async () => new Map([['S1', 'Store 1']]), issues: async () => [], guardVersion: async () => 0, recordIssue: async () => {},
      ...(calendar === undefined ? {} : { calendar }),
    }).find((r) => r.method === 'GET' && r.path === '/v1/receipt-prefixes')!;
    expect(((await route().handler(ctx())).body as { currentFinancialYear: string }).currentFinancialYear).toBe('2027-28');
    expect(((await route(() => DUBAI).handler(ctx())).body as { currentFinancialYear: string }).currentFinancialYear).toBe('2026-27');
  });
});
