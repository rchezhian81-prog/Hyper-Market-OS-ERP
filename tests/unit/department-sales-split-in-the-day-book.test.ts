// OB-340 (owner, 24 Oct 2026, in writing): "exact net value per line after its discount, to its department (day book
// change)". The day book carries each sale and sale-return line's exact taxable value — after the line's own discount — to
// the department that owns its product; the revenue line of the voucher is split the same way, each part naming its
// department; the voucher still balances and every account's total is unchanged to the paisa. The department sales and
// margin read straight off those journals and tie to the ledger. Pure engines; synthetic figures only.
import { describe, it, expect } from 'vitest';
import {
  buildDayBook, postDayBook, dayBookLedgerLines, splitInclusive, DEFAULT_RETAIL_POSTING_MAP,
  type DayBookSale, type DayBookReturn,
} from '../../packages/finance/src/index';
import { departmentSales, centreReport, trialBalance, type LedgerJournal } from '../../packages/finance/src/trial-balance';

const DAY = '2026-10-24';
const RATES = new Map([['GHEE', 1800], ['RICE', 500], ['SALT', 0], ['PEN', 1200]]);
const DEPT = new Map([['GHEE', 'dept-dairy'], ['RICE', 'dept-grocery'], ['SALT', 'dept-grocery']]); // PEN: no department owns it
const departmentOf = (p: string): string | undefined => DEPT.get(p);

// A bill with a discount on two lines: each line's total is what the lane charged AFTER its own discount.
const S1: DayBookSale = {
  saleId: 'S1', tradingDay: DAY, totalMinor: 10_001 + 5_003 + 1_999 + 2_360,
  lines: [
    { productId: 'GHEE', quantityMinor: 1, lineTotalMinor: 10_001, taxRateBps: 1800 }, // ₹110.01 less a ₹9.99 discount
    { productId: 'RICE', quantityMinor: 1, lineTotalMinor: 5_003, taxRateBps: 500 },
    { productId: 'SALT', quantityMinor: 1, lineTotalMinor: 1_999, taxRateBps: 0 },
    { productId: 'PEN', quantityMinor: 2, lineTotalMinor: 2_360, taxRateBps: 1200 },
  ],
  tenders: [{ kind: 'cash', amountMinor: 19_363 }],
};
const book = (sales: readonly DayBookSale[], returns: readonly DayBookReturn[] = [], withDepartments = true) => buildDayBook({
  tradingDay: DAY, sales, returns, originalSales: new Map(sales.map((s) => [s.saleId, s] as const)),
  taxRateOf: (p) => RATES.get(p), alreadyPosted: new Map(), ...(withDepartments ? { departmentOf } : {}),
});

describe('the day book carries each line\'s exact net to its department (OB-340)', () => {
  it('each department gets exactly its own lines\' net after discount; what no department owns stays out; nets add to the voucher', () => {
    const b = book([S1]);
    const sale = b.aggregates.find((a) => a.kind === 'sale')!;
    const ghee = splitInclusive(10_001, 1800).net;
    const rice = splitInclusive(5_003, 500).net;
    const pen = splitInclusive(2_360, 1200).net;
    expect(sale.netByDepartment).toEqual({ 'dept-dairy': ghee, 'dept-grocery': rice + 1_999 });
    expect(sale.components['net']).toBe(ghee + rice + 1_999 + pen);
  });

  it('without the department owner, the day book is exactly as before (no split field)', () => {
    const sale = book([S1], [], false).aggregates.find((a) => a.kind === 'sale')!;
    expect(sale.netByDepartment).toBeUndefined();
    expect(Object.keys(sale)).toEqual(['kind', 'sourceKind', 'sourceIds', 'components']);
  });

  it('the revenue line is carried per department; the voucher balances and every account total is unchanged', () => {
    const b = book([S1]);
    const { journals } = postDayBook(b, DEFAULT_RETAIL_POSTING_MAP, 'INR');
    const { aggregate, entry } = journals.find((j) => j.aggregate.kind === 'sale')!;
    const lines = dayBookLedgerLines(aggregate, entry, DEFAULT_RETAIL_POSTING_MAP);
    const revenue = lines.filter((l) => l.accountCode === 'sales_revenue');
    expect(revenue).toEqual([
      { accountCode: 'sales_revenue', debitMinor: 0, creditMinor: aggregate.netByDepartment!['dept-dairy'], centre: 'dept-dairy' },
      { accountCode: 'sales_revenue', debitMinor: 0, creditMinor: aggregate.netByDepartment!['dept-grocery'], centre: 'dept-grocery' },
      { accountCode: 'sales_revenue', debitMinor: 0, creditMinor: splitInclusive(2_360, 1200).net }, // the pen: no department — the store's
    ]);
    const total = (ls: readonly { debitMinor: number; creditMinor: number }[], side: 'debitMinor' | 'creditMinor') => ls.reduce((s, l) => s + l[side], 0);
    expect(total(lines, 'debitMinor')).toBe(total(lines, 'creditMinor'));
    for (const account of new Set(entry.lines.map((l) => l.account))) {
      const posted = entry.lines.filter((l) => l.account === account).reduce((s, l) => s + l.amount.minor, 0);
      const carried = lines.filter((l) => l.accountCode === account).reduce((s, l) => s + l.debitMinor + l.creditMinor, 0);
      expect(carried, account).toBe(posted);
    }
    // The tender voucher has no net leg: carried as posted.
    const cash = journals.find((j) => j.aggregate.kind === 'tender:cash')!;
    expect(dayBookLedgerLines(cash.aggregate, cash.entry, DEFAULT_RETAIL_POSTING_MAP).every((l) => l.centre === undefined)).toBe(true);
  });

  it('a return takes each line\'s net back off its own department — weighted by the original sale; a receipt-less mixed return is said, not guessed', () => {
    const back: DayBookReturn = { returnId: 'R1', originalSaleId: 'S1', refundMinor: 5_003 + 1_999, refundTender: 'cash', lines: [{ productId: 'RICE', quantityMinor: 1 }, { productId: 'GHEE', quantityMinor: 1 }] };
    // Two rates on the original: the multi-rate weighting gives each line its part, then its net.
    const ret = book([S1], [{ ...back, refundMinor: 5_003 + 10_001 }]).aggregates.find((a) => a.kind === 'sale_return')!;
    expect(ret.netByDepartment).toEqual({ 'dept-dairy': splitInclusive(10_001, 1800).net, 'dept-grocery': splitInclusive(5_003, 500).net });
    // One rate, two departments, an original sale: split by what each line cost on the original — exact to the paisa.
    const S2: DayBookSale = { ...S1, saleId: 'S2', totalMinor: 3_000, lines: [{ productId: 'SALT', quantityMinor: 1, lineTotalMinor: 2_000, taxRateBps: 0 }, { productId: 'PEN', quantityMinor: 1, lineTotalMinor: 1_000, taxRateBps: 0 }], tenders: [{ kind: 'cash', amountMinor: 3_000 }] };
    const r2 = book([S2], [{ returnId: 'R2', originalSaleId: 'S2', refundMinor: 3_000, refundTender: 'cash', lines: [{ productId: 'SALT', quantityMinor: 1 }, { productId: 'PEN', quantityMinor: 1 }] }])
      .aggregates.find((a) => a.kind === 'sale_return')!;
    expect(r2.netByDepartment).toEqual({ 'dept-grocery': 2_000 });
    expect(r2.components['net']).toBe(3_000);
    // A single-line return takes its whole net to its department.
    const r3 = book([S1], [{ returnId: 'R3', originalSaleId: 'S1', refundMinor: 10_001, refundTender: 'cash', lines: [{ productId: 'GHEE', quantityMinor: 1 }] }])
      .aggregates.find((a) => a.kind === 'sale_return')!;
    expect(r3.netByDepartment).toEqual({ 'dept-dairy': splitInclusive(10_001, 1800).net });
  });

  it('a receipt-less return of one rate across two departments keeps its net with the store and names the return', () => {
    const rates = new Map([['A', 0], ['B', 0]]);
    const b = buildDayBook({
      tradingDay: DAY, sales: [], returns: [{ returnId: 'R5', originalSaleId: null, refundMinor: 900, refundTender: 'cash', lines: [{ productId: 'A', quantityMinor: 1 }, { productId: 'B', quantityMinor: 1 }] }],
      originalSales: new Map(), taxRateOf: (p) => rates.get(p), alreadyPosted: new Map(), departmentOf: (p) => (p === 'A' ? 'd1' : 'd2'),
    });
    const r = b.aggregates.find((a) => a.kind === 'sale_return')!;
    expect(r.netByDepartment).toBeUndefined();
    expect(r.departmentNotKnown).toEqual(['R5']);
    expect(r.components['net']).toBe(900);
  });
});

describe('department sales and margin tie to the ledger (OB-340)', () => {
  const J = (entryId: string, lines: [string, number, number, string?][], dayBook?: { departmentNotKnown?: string[] }): LedgerJournal & { dayBook?: { departmentNotKnown?: string[] } } => ({
    entryId, period: '2026-10', lines: lines.map(([accountCode, debitMinor, creditMinor, centre]) => ({ accountCode, debitMinor, creditMinor, ...(centre === undefined ? {} : { centre }) })),
    ...(dayBook === undefined ? {} : { dayBook }),
  });
  const journals = [
    J('daybook:sale', [['sales_clearing', 20_000, 0], ['sales_revenue', 0, 9_000, 'dept-dairy'], ['sales_revenue', 0, 6_000, 'dept-grocery'], ['sales_revenue', 0, 2_000], ['gst_output_cgst', 0, 1_500], ['gst_output_sgst', 0, 1_500]], {}),
    J('daybook:return', [['sales_revenue', 1_000, 0, 'dept-grocery'], ['sales_clearing', 0, 1_000]], { departmentNotKnown: ['R9'] }),
    J('b2b', [['trade_receivables', 4_000, 0], ['sales_revenue', 0, 4_000]]),
    J('other-month', [['cash', 1, 0], ['sales_revenue', 0, 1, 'dept-dairy']]),
  ];
  journals[3] = { ...journals[3]!, period: '2026-09' };
  const departments = [{ departmentId: 'dept-dairy', name: 'Dairy' }, { departmentId: 'dept-grocery', name: 'Grocery' }, { departmentId: 'dept-toys', name: 'Toys' }];

  it('each department\'s sales are the ledger\'s own lines; with the rest they add to the month\'s revenue', () => {
    const d = departmentSales({ period: '2026-10', journals, departments, revenueAccounts: ['sales_revenue'], costs: [{ departmentId: 'dept-dairy', costMinor: 6_300, notCosted: [] }, { departmentId: 'dept-grocery', costMinor: null, notCosted: ['p-rice'] }] });
    expect(d.departments).toEqual([
      { departmentId: 'dept-dairy', name: 'Dairy', salesMinor: 9_000, costMinor: 6_300, marginMinor: 2_700, marginBps: 3_000, notCosted: [], journals: 1 },
      { departmentId: 'dept-grocery', name: 'Grocery', salesMinor: 5_000, costMinor: null, marginMinor: null, marginBps: null, notCosted: ['p-rice'], journals: 2 },
      { departmentId: 'dept-toys', name: 'Toys', salesMinor: 0, costMinor: 0, marginMinor: 0, marginBps: null, notCosted: [], journals: 0 },
    ]);
    expect(d).toMatchObject({ notInADepartmentMinor: 6_000, ledgerRevenueMinor: 20_000, ties: true, departmentNotKnown: ['R9'] });
    // The ledger's revenue is the trial balance's own figure for the account.
    const tb = trialBalance('2026-10', journals).rows.find((r) => r.account === 'sales_revenue')!;
    expect(tb.periodCreditMinor - tb.periodDebitMinor).toBe(d.ledgerRevenueMinor);
    // And the centre report places the same lines in the same departments.
    const c = centreReport({ period: '2026-10', journals, attributionOf: () => ({ kind: 'whole', centre: 'store-1', basis: 'store' }) });
    expect(c.ties).toBe(true);
    expect(c.centres.find((x) => x.centre === 'dept-dairy')!.accounts).toEqual([{ account: 'sales_revenue', debitMinor: 0, creditMinor: 9_000 }]);
  });

  it('a department that sold with no worked-out cost shows its margin as not known — never a 100% margin on a zero cost', () => {
    const d = departmentSales({ period: '2026-10', journals, departments, revenueAccounts: ['sales_revenue'] });
    expect(d.departments.find((r) => r.departmentId === 'dept-dairy')).toMatchObject({ salesMinor: 9_000, costMinor: null, marginMinor: null });
  });

  it('with no mapping yet, the revenue accounts are the ones the department lines were posted to', () => {
    expect(departmentSales({ period: '2026-10', journals, departments, revenueAccounts: [] }).revenueAccounts).toEqual(['sales_revenue']);
  });
});
