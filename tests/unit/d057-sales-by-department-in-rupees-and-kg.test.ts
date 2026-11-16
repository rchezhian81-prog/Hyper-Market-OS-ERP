import { describe, it, expect } from 'vitest';
import { createReportingSession, undeclaredColumns, kgWords, type ReportingConfig, type ReportingPorts } from '../../apps/web-erp/src/reporting-session';
import { REPORTS } from '../../packages/reporting/src/index';

/**
 * **D-057 (OB-800 THE PLAN, daily-work walkthrough): "What is selling, by department" showed only "Items sold", with no
 * rupees, and a 0.850 kg tomato counted as 1 item.** The store computer now sums what the till charged on each line, per
 * department, and the weight of every weighed line (tests/unit/edge-feeds-the-screens.test.ts); the report leads with the
 * rupees, gives items and kg beside them, and a department whose lines came from a till that wrote no line money says its
 * money is not complete — never a short figure.
 */

function session(over: Partial<ReportingPorts> = {}) {
  // The same shape as erp-reporting-session.test.ts: an owner who may run sales reports, departments on the catalogue.
  const config = { userId: 'u-owner' } as unknown as ReportingConfig;
  const ports = {
    access: () => ({ can: () => true, check: () => ({ allowed: true }) }),
    records: () => ['sales_rung_at_the_till', 'departments_on_the_catalogue'],
    sales: () => [], lastSyncedAt: () => '2026-11-16T09:59:00.000Z', unsentCount: () => 0, exceptions: () => [], exceptionRulesKnown: () => true,
    dayTotals: () => [], unitsByCategory: () => ({ grocery: 2, veg: 1 }), unitsWithNoCategory: () => 0,
    categoryNames: () => ({ grocery: 'Grocery', veg: 'Fruit & Veg' }),
    ...over,
  } as unknown as ReportingPorts;
  return createReportingSession(config, ports);
}

describe('D-057 — sales by department in rupees, items and kg', () => {
  it('kgWords writes grams as kg to the gram', () => {
    expect(kgWords(850)).toBe('0.850 kg');
    expect(kgWords(2_100)).toBe('2.100 kg');
    expect(kgWords(0)).toBe('0.000 kg');
  });

  it('with the store computer\'s line money: rupees lead, items and kg beside them, largest money first', () => {
    const out = session({ salesByCategory: () => ({
      grocery: { items: 2, grams: 1_250, takenMinor: 9_000, linesWithNoMoney: 0 },
      veg: { items: 0, grams: 850, takenMinor: 3_400, linesWithNoMoney: 0 },
    }) }).run('units_by_category');
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    expect(out.result.figures.map((f) => [f.name, f.valueMinor])).toEqual([
      ['Grocery — taken', 9_000], ['Fruit & Veg — taken', 3_400], ['Grocery — items', 2],
    ]);
    expect(out.rows).toEqual([
      { department: 'Grocery', takenMinor: '9000', items: '2', weighed: '1.250 kg' },
      { department: 'Fruit & Veg', takenMinor: '3400', items: '0', weighed: '0.850 kg' },
    ]);
    expect(undeclaredColumns(out.rows, REPORTS.find((r) => r.id === 'units_by_category')!.columns ?? [])).toEqual([]);
  });

  it('a department with a line that carried no money says its money is not complete — never a short figure', () => {
    const out = session({ salesByCategory: () => ({ grocery: { items: 3, grams: 0, takenMinor: 4_000, linesWithNoMoney: 1 } }) }).run('units_by_category');
    if (!out.ok) throw new Error(JSON.stringify(out));
    const taken = out.result.figures.find((f) => f.name === 'Grocery — taken')!;
    expect(taken.valueMinor).toBeUndefined();
    expect(taken.notAvailableBecause).toMatch(/not complete/);
    expect(out.rows[0]!['takenMinor']).toBe('not complete');
  });

  it('an older store computer without line money: the units report as before', () => {
    const out = session().run('units_by_category');
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.result.figures.map((f) => f.name)).toEqual(['Grocery', 'Fruit & Veg']);
  });
});
