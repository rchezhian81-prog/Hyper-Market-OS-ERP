// M23-FR-01 — the day book engine: a trading day's sales and returns → per-kind aggregates → balanced
// journals through the mapping, with every receipt in a journal or a named exception (P-08).
import { describe, it, expect } from 'vitest';
import {
  buildDayBook, postDayBook, validatePostingMap, splitInclusive, returnedValue, refundLegs,
  DEFAULT_RETAIL_POSTING_MAP, type DayBookSale, type DayBookReturn, type PostingMap,
} from '../../packages/finance/src/index';
import { money } from '../../packages/contracts/src/money';

const DAY = '2026-09-28';
const RATES = new Map([['RICE', 500], ['SOAP', 1800], ['MILK', 0]]);
const rateOf = (p: string): number | undefined => RATES.get(p);

const sale = (over: Partial<DayBookSale> = {}): DayBookSale => ({
  saleId: 's1', tradingDay: DAY, totalMinor: 10_500,
  lines: [{ productId: 'RICE', quantityMinor: 1, lineTotalMinor: 10_500 }],
  tenders: [{ kind: 'cash', amountMinor: 10_500 }],
  ...over,
});
const ret = (over: Partial<DayBookReturn> = {}): DayBookReturn => ({
  returnId: 'r1', originalSaleId: 's1', refundMinor: 10_500, refundTender: 'cash',
  lines: [{ productId: 'RICE', quantityMinor: 1 }],
  ...over,
});
const ALL_KINDS = ['sale', 'tender:cash', 'tender:card', 'tender:upi', 'sale_return', 'refund:cash'];
/** Mark receipts as posted for EVERY kind (the common re-run case); pass a Map to cover some kinds only. */
const posted = (already: readonly string[] | ReadonlyMap<string, ReadonlySet<string>>): ReadonlyMap<string, ReadonlySet<string>> =>
  Array.isArray(already) ? new Map(ALL_KINDS.map((k) => [k, new Set(already)] as const)) : already as ReadonlyMap<string, ReadonlySet<string>>;
const book = (
  sales: readonly DayBookSale[], returns: readonly DayBookReturn[] = [],
  already: readonly string[] | ReadonlyMap<string, ReadonlySet<string>> = [], originals: readonly DayBookSale[] = sales,
) =>
  buildDayBook({
    tradingDay: DAY, sales, returns, originalSales: new Map(originals.map((s) => [s.saleId, s] as const)),
    taxRateOf: rateOf, alreadyPosted: posted(already),
  });
const byKind = (b: ReturnType<typeof book>, kind: string) => {
  const a = b.aggregates.find((x) => x.kind === kind);
  if (a === undefined) throw new Error(`no aggregate ${kind}`);
  return a;
};

// Three sales: 5% rice by cash, 18% soap by UPI, exempt milk split cash + card.
const S1 = sale();
const S2 = sale({ saleId: 's2', totalMinor: 11_800, lines: [{ productId: 'SOAP', quantityMinor: 1, lineTotalMinor: 11_800 }], tenders: [{ kind: 'upi', amountMinor: 11_800 }] });
const S3 = sale({
  saleId: 's3', totalMinor: 5_000, lines: [{ productId: 'MILK', quantityMinor: 2, lineTotalMinor: 5_000 }],
  tenders: [{ kind: 'cash', amountMinor: 2_000 }, { kind: 'card', amountMinor: 3_000 }],
});

describe('splitInclusive — GST pulled out of the inclusive price (A9)', () => {
  it('splits an inclusive amount into taxable + CGST + SGST that add back to the paisa', () => {
    expect(splitInclusive(10_500, 500)).toEqual({ total: 10_500, net: 10_000, tax: 500, cgst: 250, sgst: 250 });
    expect(splitInclusive(11_800, 1800)).toEqual({ total: 11_800, net: 10_000, tax: 1_800, cgst: 900, sgst: 900 });
  });
  it('an exempt rate is all net; nothing is nothing', () => {
    expect(splitInclusive(5_000, 0)).toEqual({ total: 5_000, net: 5_000, tax: 0, cgst: 0, sgst: 0 });
    expect(splitInclusive(0, 1800)).toEqual({ total: 0, net: 0, tax: 0, cgst: 0, sgst: 0 });
  });
});

describe('buildDayBook — the day, summed per posting kind', () => {
  it('sums the day per kind and lists the receipts each figure is made of', () => {
    const b = book([S1, S2, S3]);
    expect(b.aggregates.map((a) => a.kind)).toEqual(['sale', 'tender:card', 'tender:cash', 'tender:upi']);
    expect(byKind(b, 'sale')).toEqual({
      kind: 'sale', sourceKind: 'sale', sourceIds: ['s1', 's2', 's3'],
      components: { total: 27_300, net: 25_000, tax: 2_300, cgst: 1_150, sgst: 1_150 },
    });
    expect(byKind(b, 'tender:cash')).toMatchObject({ sourceIds: ['s1', 's3'], components: { amount: 12_500 } });
    expect(byKind(b, 'tender:upi')).toMatchObject({ sourceIds: ['s2'], components: { amount: 11_800 } });
    expect(byKind(b, 'tender:card')).toMatchObject({ sourceIds: ['s3'], components: { amount: 3_000 } });
    expect(b.exceptions).toEqual([]);
    expect(b.counted).toEqual({ sales: 3, returns: 0 });
  });

  it('the rate frozen on the line wins over the catalogue (a mid-period rate change posts as it sold)', () => {
    const frozen = sale({ lines: [{ productId: 'RICE', quantityMinor: 1, lineTotalMinor: 10_500, taxRateBps: 1800 }] });
    const b = book([frozen]);
    expect(byKind(b, 'sale').components).toMatchObject({ total: 10_500, tax: splitInclusive(10_500, 1800).tax });
  });

  it('a sale whose product has no GST rate anywhere is an exception naming the receipt — and posts nothing, not even its tender', () => {
    const b = book([S1, sale({ saleId: 's9', lines: [{ productId: 'MYSTERY', quantityMinor: 1, lineTotalMinor: 10_500 }] })]);
    expect(b.exceptions).toEqual([expect.objectContaining({ sourceKind: 'sale', sourceIds: ['s9'], reason: 'tax_rate_unknown' })]);
    expect(byKind(b, 'sale').sourceIds).toEqual(['s1']);
    expect(byKind(b, 'tender:cash').components).toEqual({ amount: 10_500 });
  });

  it('a receipt that does not add up is an exception, never a guessed figure', () => {
    const b = book([
      sale({ saleId: 'bad-lines', totalMinor: 10_500, lines: [{ productId: 'RICE', quantityMinor: 1, lineTotalMinor: 9_000 }] }),
      sale({ saleId: 'bad-tenders', tenders: [{ kind: 'cash', amountMinor: 10_000 }] }),
      sale({ saleId: 'negative', totalMinor: -100, lines: [{ productId: 'RICE', quantityMinor: 1, lineTotalMinor: -100 }], tenders: [{ kind: 'cash', amountMinor: -100 }] }),
    ]);
    expect(b.exceptions.map((e) => [e.sourceIds[0], e.reason])).toEqual([
      ['bad-lines', 'lines_do_not_sum_to_total'], ['bad-tenders', 'tenders_do_not_sum_to_total'], ['negative', 'negative_line'],
    ]);
    expect(b.aggregates).toEqual([]);
  });

  it('a receipt an earlier posting already covers is skipped — a re-run never counts it twice', () => {
    const b = book([S1, S2, S3], [], ['s1', 's2']);
    expect(b.skipped).toEqual(['s1', 's2']);
    expect(byKind(b, 'sale').sourceIds).toEqual(['s3']);
    expect(byKind(b, 'sale').components.total).toBe(5_000);
    expect(b.aggregates.map((a) => a.kind)).toEqual(['sale', 'tender:card', 'tender:cash']);
  });

  it('covered PER KIND: a sale whose voucher posted while its tender was unmapped owes exactly its tender leg, once', () => {
    const b = book([S1, S2], [], new Map([['sale', new Set(['s1', 's2'])], ['tender:cash', new Set(['s1'])]]));
    expect(b.aggregates).toEqual([{ kind: 'tender:upi', sourceKind: 'sale', sourceIds: ['s2'], components: { amount: 11_800 } }]);
    expect(b.skipped).toEqual(['s1']);
    expect(b.exceptions).toEqual([]);
  });

  it('a return reverses revenue and tax at the original rate and shows how the money went back', () => {
    const b = book([], [ret()], [], [S1]);
    expect(byKind(b, 'sale_return')).toEqual({
      kind: 'sale_return', sourceKind: 'return', sourceIds: ['r1'],
      components: { total: 10_500, net: 10_000, tax: 500, cgst: 250, sgst: 250 },
    });
    expect(byKind(b, 'refund:cash')).toMatchObject({ sourceIds: ['r1'], components: { amount: 10_500 } });
  });

  it('a multi-rate return is weighted by what each line was worth on the original bill', () => {
    const S4 = sale({
      saleId: 's4', totalMinor: 22_300,
      lines: [{ productId: 'RICE', quantityMinor: 1, lineTotalMinor: 10_500 }, { productId: 'SOAP', quantityMinor: 1, lineTotalMinor: 11_800 }],
      tenders: [{ kind: 'cash', amountMinor: 22_300 }],
    });
    const b = book([], [ret({ returnId: 'r4', originalSaleId: 's4', refundMinor: 22_300, lines: [{ productId: 'RICE', quantityMinor: 1 }, { productId: 'SOAP', quantityMinor: 1 }] })], [], [S4]);
    expect(byKind(b, 'sale_return').components).toEqual({ total: 22_300, net: 20_000, tax: 2_300, cgst: 1_150, sgst: 1_150 });
  });

  it('a receipt-less return splits at the one rate its lines share, and is an exception when they differ', () => {
    const one = book([], [ret({ returnId: 'nr1', originalSaleId: null, refundMinor: 11_800, lines: [{ productId: 'SOAP', quantityMinor: 1 }] })], [], []);
    expect(byKind(one, 'sale_return').components).toEqual({ total: 11_800, net: 10_000, tax: 1_800, cgst: 900, sgst: 900 });
    const mixed = book([], [ret({ returnId: 'nr2', originalSaleId: null, refundMinor: 22_300, lines: [{ productId: 'RICE', quantityMinor: 1 }, { productId: 'SOAP', quantityMinor: 1 }] })], [], []);
    expect(mixed.exceptions).toEqual([expect.objectContaining({ sourceIds: ['nr2'], reason: 'refund_split_unknown' })]);
    expect(mixed.aggregates).toEqual([]);
  });

  it('an exchange credits what was applied plus any refunded balance, and names both legs', () => {
    const refunded = ret({ returnId: 'x1', refundMinor: 500, exchange: { appliedMinor: 10_000, balance: 'refund', balanceMinor: 500, balanceTender: 'cash' } });
    expect(returnedValue(refunded)).toBe(10_500);
    expect(refundLegs(refunded)).toEqual([{ kind: 'exchange_credit', amountMinor: 10_000 }, { kind: 'cash', amountMinor: 500 }]);
    const topUp = ret({ returnId: 'x2', refundMinor: 0, exchange: { appliedMinor: 10_500, balance: 'top_up', balanceMinor: 1_300 } });
    expect(returnedValue(topUp)).toBe(10_500);
    expect(refundLegs(topUp)).toEqual([{ kind: 'exchange_credit', amountMinor: 10_500 }]);
    const b = book([], [refunded, topUp], [], [S1]);
    expect(byKind(b, 'sale_return').components.total).toBe(21_000);
    expect(byKind(b, 'refund:exchange_credit').components).toEqual({ amount: 20_500 });
    expect(byKind(b, 'refund:cash').components).toEqual({ amount: 500 });
  });

  it('a zero-value return has nothing to post and is said so, not lost', () => {
    const b = book([], [ret({ returnId: 'z1', refundMinor: 0 })], [], [S1]);
    expect(b.aggregates).toEqual([]);
    expect(b.zeroValue).toEqual(['z1']);
    expect(b.exceptions).toEqual([]);
  });
});

describe('postDayBook — the aggregates through the mapping', () => {
  it('every kind posts as a balanced journal under the suggested retail mapping; the clearing nets to zero', () => {
    const { journals, exceptions } = postDayBook(book([S1, S2, S3]), DEFAULT_RETAIL_POSTING_MAP, 'INR');
    expect(exceptions).toEqual([]);
    expect(journals.map((j) => j.aggregate.kind)).toEqual(['sale', 'tender:card', 'tender:cash', 'tender:upi']);
    for (const j of journals) expect(j.entry.balanced).toBe(true);
    const saleEntry = journals[0]!.entry;
    expect(saleEntry.lines).toEqual([
      { account: 'sales_clearing', side: 'debit', amount: money(27_300, 'INR') },
      { account: 'sales_revenue', side: 'credit', amount: money(25_000, 'INR') },
      { account: 'gst_output_cgst', side: 'credit', amount: money(1_150, 'INR') },
      { account: 'gst_output_sgst', side: 'credit', amount: money(1_150, 'INR') },
    ]);
    let clearing = 0;
    for (const j of journals) {
      for (const l of j.entry.lines) if (l.account === 'sales_clearing') clearing += l.side === 'debit' ? l.amount.minor : -l.amount.minor;
    }
    expect(clearing).toBe(0);
  });

  it('a tender kind the mapping does not name is ONE exception naming every receipt paid that way; the rest still posts', () => {
    const noUpi: PostingMap = { rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => r.kind !== 'tender:upi') };
    const { journals, exceptions } = postDayBook(book([S1, S2, S3]), noUpi, 'INR');
    expect(journals.map((j) => j.aggregate.kind)).toEqual(['sale', 'tender:card', 'tender:cash']);
    expect(exceptions).toEqual([expect.objectContaining({ kind: 'tender:upi', reason: 'unmapped_kind', sourceIds: ['s2'], sourceKind: 'sale' })]);
    expect(exceptions[0]!.detail).toContain('tender:upi');
  });

  it('a rule asking for a component the day does not carry is a missing-component exception', () => {
    const odd: PostingMap = { rules: [{ kind: 'sale', legs: [{ account: 'a', side: 'debit', component: 'total' }, { account: 'b', side: 'credit', component: 'cess' }] }] };
    const { exceptions } = postDayBook(book([S1]), odd, 'INR');
    expect(exceptions.map((e) => [e.kind, e.reason])).toEqual([['sale', 'missing_component'], ['tender:cash', 'unmapped_kind']]);
  });
});

describe('validatePostingMap — the shape of what the accountant may define', () => {
  it('accepts the suggested retail mapping', () => {
    expect(validatePostingMap(DEFAULT_RETAIL_POSTING_MAP)).toEqual({ ok: true, map: DEFAULT_RETAIL_POSTING_MAP });
  });
  it('names each problem: no rules, a duplicate kind, too few legs, a leg with no account, a bad side, no credit leg', () => {
    expect(validatePostingMap({})).toMatchObject({ ok: false, problems: [expect.stringContaining('non-empty `rules`')] });
    const bad = validatePostingMap({
      rules: [
        { kind: 'sale', legs: [{ account: 'a', side: 'debit', component: 'total' }, { account: 'b', side: 'credit', component: 'net' }] },
        { kind: 'sale', legs: [{ account: 'a', side: 'debit', component: 'total' }, { account: 'b', side: 'credit', component: 'net' }] },
        { kind: 'one-leg', legs: [{ account: 'a', side: 'debit', component: 'total' }] },
        { kind: 'no-account', legs: [{ side: 'debit', component: 'total' }, { account: 'b', side: 'sideways', component: 'net' }] },
        { kind: 'all-debit', legs: [{ account: 'a', side: 'debit', component: 'total' }, { account: 'b', side: 'debit', component: 'net' }] },
      ],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems).toEqual([
      expect.stringContaining("kind 'sale' is mapped twice"),
      expect.stringContaining("'one-leg': needs at least two legs"),
      expect.stringContaining("'no-account' leg 1: needs an `account`"),
      expect.stringContaining("'no-account' leg 2: `side` must be"),
      expect.stringContaining("'no-account': needs at least one debit leg and one credit leg"),
      expect.stringContaining("'all-debit': needs at least one debit leg and one credit leg"),
    ]);
  });
});
