import { describe, it, expect } from 'vitest';
import {
  readExport, diffExports, diffExceptions, judgeExportMapping, fingerprint,
  readBooksReport, compareBooksDay, booksTemplateCsv,
  crossedLimits, limitsNotSet, backupStanding, COMPARISON_AREAS, BOOKS_AREAS,
  type RollbackLimits, type HeadOfficeBooksDay,
} from '../../packages/migration/src/index';

// OB-288 P5 — the pure engines behind MG-09 (two full exports compared), MG-10 (the books side of a day) and MG-11 (the
// owner's rollback limits and the backup check). Synthetic figures only.

describe('MG-09 — two full exports compared (OB-309)', () => {
  const map = { item_code: 'Code', name: 'Name', tax_rate: 'GST %' };
  const read = (text: string) => { const r = readExport('items', text, map); if (!r.ok) throw new Error(r.problems.join('; ')); return r; };

  it('reads through the mapping only: title lines above, a total line below, a % sign, extra columns ignored', () => {
    const r = read('Item master\r\nCode,Name,GST %,Supplier phone\r\nP1,Rice,5%,90000 11111\r\nGrand Total,,,\r\n');
    expect([...r.rows.entries()]).toEqual([['P1', { item_code: 'P1', name: 'Rice', tax_rate: '5' }]]);
    expect(r.totalLinesSkipped).toBe(1);
  });

  it('refuses a whole export with a code Excel turned into scientific notation, or a key twice', () => {
    const sci = readExport('items', 'Code,Name,GST %\r\n8.90123E+12,Rice,5\r\n', map);
    expect(sci.ok).toBe(false);
    expect(sci.ok ? '' : sci.problems[0]).toMatch(/lost its digits/);
    const dup = readExport('items', 'Code,Name,GST %\r\nP1,a,5\r\nP1,b,5\r\n', map);
    expect(dup.ok ? '' : dup.problems[0]).toMatch(/P1 appears twice/);
    expect(judgeExportMapping('items', { name: 'Name' }).ok).toBe(false); // the key is required
    expect(judgeExportMapping('items', { item_code: 'Code', colour: 'Colour' }).ok).toBe(false); // not a field
  });

  it('names added, changed and removed — each a blocking exception, keyed so a re-run is the same exception', () => {
    const before = read('Code,Name,GST %\r\nP1,Rice,5\r\nP2,Dal,5\r\nP3,Salt,0\r\n');
    const after = read('Code,Name,GST %\r\nP1,Rice,5\r\nP2,Dal,12\r\nP4,Ghee,12\r\n');
    const diff = diffExports('items', before, after);
    expect(diff).toMatchObject({ unchanged: 1, added: [{ key: 'P4' }], removed: [{ key: 'P3' }], changed: [{ key: 'P2', changes: [{ field: 'tax_rate', before: '5', after: '12', personal: false }] }] });
    const ex = diffExceptions('d1', 't', diff);
    expect(ex.map((e) => [e.kind, e.severity, e.legacyIds[0]])).toEqual([['delta_added', 'blocking', 'P4'], ['delta_changed', 'blocking', 'P2'], ['delta_removed', 'blocking', 'P3']]);
    expect(diffExceptions('d1', 't', diff).map((e) => e.exceptionId)).toEqual(ex.map((e) => e.exceptionId));
  });

  it('never keeps or shows a customer\'s personal value — a fingerprint says it changed', () => {
    const m = { customer_code: 'No', phone: 'Mobile' };
    const a = readExport('customers', 'No,Mobile\r\nC1,90000 00001\r\n', m);
    const b = readExport('customers', 'No,Mobile\r\nC1,90000 00002\r\n', m);
    if (!a.ok || !b.ok) throw new Error('unreadable');
    expect(a.rows.get('C1')!['phone']).toBe(fingerprint('90000 00001'));
    const diff = diffExports('customers', a, b);
    expect(diff.changed[0]!.changes[0]).toEqual({ field: 'phone', before: '(personal — not shown)', after: '(personal — not shown)', personal: true });
    expect(JSON.stringify(diffExceptions('d', 't', diff))).not.toContain('90000');
  });
});

describe('MG-10 — the books side of a day', () => {
  const ho: HeadOfficeBooksDay = {
    purchases: [{ supplierId: 'S1', billNumber: 'B1', valueMinor: 10_000 }, { supplierId: 'S1', billNumber: 'B2', valueMinor: 5_000 }],
    supplierBalances: [{ supplierId: 'S1', owedMinor: 15_000 }],
    customerBalances: [{ customerId: 'C1', owedMinor: 2_000 }],
    stock: [{ productId: 'P1', thousandths: 12_000, valueMinor: 60_000 }, { productId: 'P2', thousandths: 1_500, valueMinor: null }],
    margin: { salesNetMinor: 50_000, costMinor: 40_000 },
  };
  it('reads a report through its mapping and refuses another day\'s bill', () => {
    const ok = readBooksReport({ report: 'purchase_register', text: 'Party,Bill,Date,Amt\r\nS1,B1,20/10/2026,100.00\r\nTotal,,,100.00\r\n', mapping: { supplier_code: 'Party', bill_number: 'Bill', bill_date: 'Date', bill_value: 'Amt' }, day: '2026-10-20' });
    expect(ok).toEqual({ ok: true, rows: [{ supplier_code: 'S1', bill_number: 'B1', bill_date: '2026-10-20', bill_value: 10_000 }] });
    const other = readBooksReport({ report: 'purchase_register', text: 'Party,Bill,Date,Amt\r\nS1,B1,19/10/2026,100.00\r\n', mapping: { supplier_code: 'Party', bill_number: 'Bill', bill_date: 'Date', bill_value: 'Amt' }, day: '2026-10-20' });
    expect(other.ok ? '' : other.problems[0]).toMatch(/another day/);
    expect(booksTemplateCsv('stock_balance')).toBe('item_code,quantity,value\r\n');
  });
  it('lines only beyond tolerance, totals always; an unvalued item makes the stock value NOT COMPARED, never zero', () => {
    const r = compareBooksDay({
      ho, tolerance: { valueMinor: 100, quantityThousandths: 0 },
      old: {
        purchase_register: [{ supplier_code: 'S1', bill_number: 'B1', bill_value: 10_050 }, { supplier_code: 'S1', bill_number: 'B3', bill_value: 700 }],
        customer_balances: [{ customer_code: 'C1', balance: 2_500 }],
        stock_balance: [{ item_code: 'P1', quantity: 12_000, value: 60_000 }, { item_code: 'P2', quantity: 1_500, value: 900 }],
        margin: [{ sales_value: 50_000, cost_value: 41_000 }],
      },
    });
    expect(r.comparisons.map((c) => [c.area, c.subject ?? '', c.legacyValue, c.newValue])).toEqual([
      ['purchase_bill_not_on_old', 'S1/B2', 0, 1], ['purchase_bill_not_on_new', 'S1/B3', 1, 0], ['purchases_value', '', 10_750, 15_000],
      ['customer_balance', 'C1', 2_500, 2_000], ['customer_balance_total', '', 2_500, 2_000],
      ['margin_sales_net', '', 50_000, 50_000], ['margin_cost', '', 41_000, 40_000],
    ]);
    expect(r.notCompared).toEqual([{ area: 'stock_value_total', why: expect.stringMatching(/P2/) }]);
    expect(r.reports).toEqual(['purchase_register', 'customer_balances', 'stock_balance', 'margin']);
  });
  it('every books area is a recordable MG-10 area', () => {
    for (const a of BOOKS_AREAS) expect(COMPARISON_AREAS).toContain(a);
  });
});

describe('MG-11 — rollback limits and the backup', () => {
  const limits: RollbackLimits = { controlTotalDifferenceMinor: 1_000, edgeOutageMinutes: 30, windowMinutes: 240, backupMaxAgeHours: 6, version: 1, setBy: 'u-owner', setAt: 'x' };
  it('names every limit not set — all four when none is recorded', () => {
    expect(limitsNotSet(undefined)).toHaveLength(4);
    expect(limitsNotSet({ ...limits, windowMinutes: null })).toEqual(['windowMinutes']);
  });
  it('raises a trigger only past a limit; a missing observation or limit is not known, never inside', () => {
    expect(crossedLimits(limits, { controlTotalDifferenceMinor: 1_000, edgeOutageMinutes: 31, minutesSinceGo: 241 }).crossed.map((c) => c.trigger)).toEqual(['edge_cannot_trade', 'time_window_exceeded']);
    expect(crossedLimits({ ...limits, edgeOutageMinutes: null }, {}).notKnown).toHaveLength(3);
  });
  it('a backup counts only completed, encrypted, off-site and within the agreed age', () => {
    const b = (at: string, over: Partial<{ ok: boolean; encrypted: boolean; offsite: boolean }> = {}) => ({ backupId: at, at, ok: true, encrypted: true, offsite: true, ...over });
    expect(backupStanding([b('2026-10-20T03:00:00Z')], 6, '2026-10-20T08:00:00Z').state).toBe('passed');
    expect(backupStanding([b('2026-10-20T01:00:00Z')], 6, '2026-10-20T08:00:00Z').state).toBe('failed');
    expect(backupStanding([b('2026-10-20T07:00:00Z', { encrypted: false })], 6, '2026-10-20T08:00:00Z').evidence).toMatch(/not encrypted/);
  });
});
