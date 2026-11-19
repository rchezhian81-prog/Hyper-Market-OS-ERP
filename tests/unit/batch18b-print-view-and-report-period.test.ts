import { describe, it, expect } from 'vitest';
import { printLayout, rupeesText, shopDateText, type PrintView } from '../../packages/documents/src/print-view';
import { coverPeriod, periodFromUrl, salesIn, MAX_PERIOD_DAYS } from '../../edge/store-edge/src/report-period';
import type { LoggedSale } from '../../edge/store-edge/src/read-model';
import { createReportingSession, PRODUCED, type ReportingPorts, type ReportCover } from '../../apps/web-erp/src/reporting-session';
import { AccessControl } from '../../packages/rbac/src/index';

/**
 * **Batch 18b — the printed page (R1 / P1 / B2 · M31-FR-02) and the period a report covers (O1 / O3 · M29-FR-02).**
 *   • the A4 page's words: the shop and the supplier with their GSTINs, the document number and date, every line with its
 *     item, quantity in its own unit, rate and GST rate, the total and the signature lines — a missing fact reads
 *     "Not on record", never blank, never guessed; in English or Tamil;
 *   • a period from the page's address, cut to exactly the days the store computer holds, never past today;
 *   • the reporting session says "Not known for this period" for what rests on today's cost, today's limits or "now",
 *     and opens a department to its items.
 */

const PO: PrintView = {
  kind: 'purchase_order', documentNumber: 'PO/26-27/00001', date: '2026-11-19',
  shop: { name: 'SRE Hyper Market', legalName: 'SRE Hyper Market Private Limited', gstin: '33AABCS1429B1Z1', address: ['12 Main Road, Tiruppur'] },
  supplier: { id: 'sup-1', name: 'Kaveri Traders', gstin: null, address: [] },
  facts: [{ key: 'deliverTo', value: 'S-A' }],
  lines: [
    { productId: 'p-rice', name: 'Ponni rice', hsn: '1006', quantityMinor: 25_000, uom: 'kg', rateMinor: 6_000, ratePer: 1, gstRateBps: 500, valueMinor: 150_000 },
    { productId: 'p-oil', name: null, hsn: null, quantityMinor: 12, uom: 'ea', rateMinor: 18_000, ratePer: 12, gstRateBps: null, valueMinor: 18_000 },
  ],
  totalMinor: 168_000, currency: 'INR', readAt: '2026-11-19T06:00:00.000Z',
};

describe('batch 18b — the printed page (A4)', () => {
  it('a purchase order: number, date, both parties with GSTINs, the lines, the total, the signatures; what is missing says so', () => {
    const page = printLayout(PO, 'en');
    expect(page.title).toBe('Purchase order');
    expect(page.head).toEqual([{ label: 'Number', value: 'PO/26-27/00001' }, { label: 'Date', value: '19/11/2026' }]);
    expect(page.parties[0]).toEqual({ heading: 'From (the shop)', name: 'SRE Hyper Market', lines: ['SRE Hyper Market Private Limited', '12 Main Road, Tiruppur', 'GSTIN: 33AABCS1429B1Z1'] });
    expect(page.parties[1]).toEqual({ heading: 'To (the supplier)', name: 'Kaveri Traders', lines: ['GSTIN: Not on record'] });
    expect(page.table.head).toEqual(['No.', 'Item', 'HSN', 'Quantity', 'Rate (₹)', 'GST rate', 'Value (₹)']);
    expect(page.table.rows).toEqual([
      ['1', 'Ponni rice (p-rice)', '1006', '25.000 kg', '60.00 per kg', '5%', '1,500.00'],
      ['2', 'p-oil', 'Not on record', '12', '180.00 / 12', 'Not on record', '180.00'],
    ]);
    expect(page.totals).toEqual([{ label: 'Total value at these rates', value: '₹1,680.00', strong: true }]);
    expect(page.notes[0]).toMatch(/GST amounts are stated on the supplier's tax invoice/);
    expect(page.signatures).toEqual(['Prepared by', 'Approved by', 'Supplier\'s acknowledgement']);
  });

  it('a goods receipt with a line whose cost waits for the bill: its rate, value and total say "Not on record", never ₹0', () => {
    const grn: PrintView = { ...PO, kind: 'goods_receipt', documentNumber: 'GRN1/26-27/00001', lines: [{ ...PO.lines[0]!, rateMinor: null, valueMinor: null }], totalMinor: null };
    const page = printLayout(grn, 'en');
    expect(page.title).toBe('Goods receipt note (GRN)');
    expect(page.table.rows[0]!.slice(4)).toEqual(['Not on record', '5%', 'Not on record']);
    expect(page.totals[0]!.value).toBe('Not on record');
    expect(page.signatures).toEqual(['Received by (store)', 'Checked by', 'Delivered by (supplier)']);
  });

  it('a supplier statement prints its account; Tamil prints Tamil words', () => {
    const st: PrintView = { ...PO, kind: 'supplier_statement', documentNumber: null, lines: [], facts: [{ key: 'asAt', value: '2026-11-19' }],
      statement: { invoicedMinor: 500_000, debitNotesMinor: 20_000, paidMinor: 300_000, withheldMinor: 0, owedMinor: 180_000 }, totalMinor: 180_000 };
    const en = printLayout(st, 'en');
    expect(en.head[0]!.value).toMatch(/^Not numbered/);
    expect(en.facts).toEqual([{ label: 'As at', value: '19/11/2026' }]);
    expect(en.table.head).toEqual([]);
    expect(en.totals.at(-1)).toEqual({ label: 'Owed to the supplier', value: '₹1,800.00', strong: true });
    const ta = printLayout(st, 'ta');
    expect(ta.title).toBe('விநியோகஸ்தர் கணக்கு அறிக்கை');
    expect(ta.totals.at(-1)!.label).toBe('விநியோகஸ்தருக்குக் கொடுக்க வேண்டியது');
    expect(rupeesText(-4_000)).toBe('−40.00');
    expect(shopDateText(null)).toBeNull();
  });
});

const sale = (id: string, tradingDay: string | undefined): LoggedSale => ({ id, ...(tradingDay === undefined ? {} : { tradingDay }), total: 100 });

describe('batch 18b — the period a report covers', () => {
  it('reads from and to from the page address; refuses what it cannot read; nothing asked is today', () => {
    expect(periodFromUrl('/reporting/')).toBeNull();
    expect(periodFromUrl('/reporting/?period=last_week&from=2026-11-09&to=2026-11-15')).toEqual({ ok: true, period: { from: '2026-11-09', to: '2026-11-15' } });
    expect(periodFromUrl('/reporting/?from=2026-11-15&to=2026-11-09')).toEqual({ ok: false, why: 'the period ends before it starts' });
    expect(periodFromUrl('/reporting/?from=2026-02-30&to=2026-03-01')).toMatchObject({ ok: false });
    expect(periodFromUrl('/reporting/?from=2024-01-01&to=2026-01-01')).toEqual({ ok: false, why: `a period is at most ${MAX_PERIOD_DAYS} days` });
  });

  it('covers exactly the days held, stops at today, and says what is not known', () => {
    const log = [sale('a', '2026-11-03'), sale('b', '2026-11-10'), sale('c', undefined)];
    expect(coverPeriod(null, '2026-11-19', log)).toEqual({ asked: { from: '2026-11-19', to: '2026-11-19' }, covered: { from: '2026-11-19', to: '2026-11-19' }, todayOnly: true, heldFrom: '2026-11-03' });
    expect(coverPeriod({ from: '2026-11-01', to: '2026-11-30' }, '2026-11-19', log)).toEqual({ asked: { from: '2026-11-01', to: '2026-11-30' }, covered: { from: '2026-11-03', to: '2026-11-19' }, todayOnly: false, heldFrom: '2026-11-03', notKnownBefore: '2026-11-03', stopsAtToday: true });
    expect(coverPeriod({ from: '2026-10-01', to: '2026-10-31' }, '2026-11-19', log)).toMatchObject({ covered: null, notKnownWhy: 'this store computer holds sales only from 2026-11-03' });
    expect(coverPeriod({ from: '2026-11-18', to: '2026-11-18' }, '2026-11-19', [])).toMatchObject({ covered: null, notKnownWhy: 'this store computer holds no sales at all yet' });
    expect(coverPeriod({ from: '2026-12-01', to: '2026-12-02' }, '2026-11-19', log)).toMatchObject({ covered: null, notKnownWhy: 'the period has not started yet' });
    expect(salesIn(log, { from: '2026-11-01', to: '2026-11-05' })).toEqual({ sales: [log[0]], undated: 1 });
    expect(salesIn(log, null)).toEqual({ sales: [], undated: 1 });
  });
});

describe('batch 18b — the reporting session for a past period, and a department opened to its items', () => {
  const ports = (period: ReportCover | undefined): ReportingPorts => ({
    access: () => new AccessControl([], []),
    records: () => ['sales_rung_at_the_till', 'cost_prices_on_the_catalogue', 'departments_on_the_catalogue', 'the_boxs_own_outbox'],
    sales: () => [{ saleId: 's1', committedAt: '2026-11-10T06:00:00.000Z', cashierId: 'u-c', netMinor: 9_000, taxMinor: 1_000, totalMinor: 10_000, units: 1, tender: 'cash' }],
    lastSyncedAt: () => '2026-11-19T05:00:00.000Z', unsentCount: () => 2, exceptions: () => [], exceptionRulesKnown: () => true,
    dayTotals: () => [{ tradingDay: '2026-11-19', totalMinor: 5_000, bills: 1 }, { tradingDay: '2026-11-10', totalMinor: 10_000, bills: 1 }, { tradingDay: '2026-11-09', totalMinor: 7_000, bills: 1 }],
    unitsByCategory: () => ({ grocery: 1 }), unitsWithNoCategory: () => 0, categoryNames: () => ({ grocery: 'Grocery' }),
    salesByCategory: () => ({ grocery: { items: 1, grams: 0, takenMinor: 10_000, linesWithNoMoney: 0, marginNotKnown: 'Not known for this period — x' } }),
    salesByItem: () => ({ grocery: [{ productId: 'p1', name: 'Toor dal', items: 1, grams: 0, takenMinor: 10_000, linesWithNoMoney: 0, marginNotKnown: 'Not known for this period — x' }] }),
    period: () => period,
    exceptionsNotKnown: () => (period?.todayOnly === false ? 'Not known for this period — limits' : undefined),
  });
  const config = { tenantId: 't', storeId: 's', userId: 'u', currency: 'INR' as const, now: '2026-11-19T06:00:00.000Z', laggingAfterMinutes: 5, staleAfterMinutes: 60, branchId: null, tradingDay: '2026-11-19' };
  const oneDay: ReportCover = { asked: { from: '2026-11-10', to: '2026-11-10' }, covered: { from: '2026-11-10', to: '2026-11-10' }, todayOnly: false, heldFrom: '2026-11-01' };

  it('a past day: sales figures from that day; now-only, cost and limits reports say "Not known for this period"; the day is compared with the one before it', () => {
    const s = createReportingSession(config, ports(oneDay));
    expect(s.period()).toEqual(oneDay);
    const byDay = s.run('sales_by_day');
    expect(byDay.ok && byDay.result.figures[0]!.valueMinor).toBe(10_000);
    for (const id of ['sync_health', 'data_freshness', 'margin', 'exceptions']) {
      const out = s.run(id);
      expect(out.ok, id).toBe(true);
      if (out.ok) for (const f of out.result.figures) expect(f.notAvailableBecause, `${id} ${f.name}`).toMatch(/^Not known for this period — /);
    }
    const dod = s.run('day_on_day');
    expect(dod.ok && dod.result.figures.map((f) => [f.name, f.valueMinor])).toEqual([['2026-11-10', 10_000], ['2026-11-09', 7_000], ['Up or down', 3_000]]);
    expect(s.departmentItems('Grocery')).toEqual([expect.objectContaining({ name: 'Toor dal', takenMinor: 10_000 })]);
    expect(s.departmentItems('Nowhere')).toBeUndefined();
    expect(PRODUCED).toContain('units_by_category');
  });

  it('a week: day-on-day asks for a single day; a period the store computer does not hold has no figures, each saying why', () => {
    const week = createReportingSession(config, ports({ ...oneDay, covered: { from: '2026-11-09', to: '2026-11-15' }, asked: { from: '2026-11-09', to: '2026-11-15' } }));
    const dod = week.run('day_on_day');
    expect(dod.ok && dod.result.figures[0]!.notAvailableBecause).toMatch(/choose a single day/);
    const none = createReportingSession(config, ports({ ...oneDay, covered: null, notKnownWhy: 'this store computer holds sales only from 2026-11-01' }));
    const out = none.run('sales_by_day');
    expect(out.ok && out.result.figures.map((f) => f.notAvailableBecause)).toEqual(['Not known for this period — this store computer holds sales only from 2026-11-01']);
    expect(out.ok && out.rows).toEqual([]);
  });

  it('an older store computer that sends no period: today, as before', () => {
    const s = createReportingSession(config, ports(undefined));
    expect(s.period()).toMatchObject({ todayOnly: true, covered: { from: '2026-11-19', to: '2026-11-19' } });
    const sync = s.run('sync_health');
    expect(sync.ok && sync.result.figures[0]!.valueMinor).toBe(2);
  });
});
