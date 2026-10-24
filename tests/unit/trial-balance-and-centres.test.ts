import { describe, it, expect } from 'vitest';
import { trialBalance, centreReport, splitByWeights, type LedgerJournal } from '../../packages/finance/src/trial-balance';
import { rebateAccrualRoutes, rebateAccrualPosition, type RebateAccrualJournal } from '../../services/finance/src/rebate-accruals';
import { advancePositions, appliedForSupplier, type SupplierAdvanceJournal } from '../../services/finance/src/supplier-advances';

// M23-FR-01 trial balance and centre report (ties to the ledger), D10-FR-04 accrual re-measure, D10-FR-01 advance
// positions. Pure engines; synthetic figures only.

const j = (entryId: string, period: string, lines: [string, number, number, string?][]): LedgerJournal => ({
  entryId, period, lines: lines.map(([accountCode, debitMinor, creditMinor, centre]) => ({ accountCode, debitMinor, creditMinor, ...(centre === undefined ? {} : { centre }) })),
});

describe('the trial balance (M23-FR-01)', () => {
  const journals = [
    j('o1', '2026-09', [['cash', 10_000, 0], ['capital', 0, 10_000]]),
    j('m1', '2026-10', [['cash', 5_000, 0], ['sales', 0, 5_000]]),
    j('m2', '2026-10', [['expense', 1_200, 0], ['cash', 0, 1_200]]),
    j('later', '2026-11', [['cash', 99, 0], ['sales', 0, 99]]),
  ];
  it('brings forward earlier months, posts the month, carries forward — and balances', () => {
    const tb = trialBalance('2026-10', journals, { cash: 'asset', sales: 'income' });
    expect(tb.rows).toEqual([
      { account: 'capital', accountClass: null, openingNetDebitMinor: -10_000, periodDebitMinor: 0, periodCreditMinor: 0, closingNetDebitMinor: -10_000 },
      { account: 'cash', accountClass: 'asset', openingNetDebitMinor: 10_000, periodDebitMinor: 5_000, periodCreditMinor: 1_200, closingNetDebitMinor: 13_800 },
      { account: 'expense', accountClass: null, openingNetDebitMinor: 0, periodDebitMinor: 1_200, periodCreditMinor: 0, closingNetDebitMinor: 1_200 },
      { account: 'sales', accountClass: 'income', openingNetDebitMinor: 0, periodDebitMinor: 0, periodCreditMinor: 5_000, closingNetDebitMinor: -5_000 },
    ]);
    expect(tb.totals).toEqual({ periodDebitMinor: 6_200, periodCreditMinor: 6_200, closingDebitMinor: 15_000, closingCreditMinor: 15_000 });
    expect(tb).toMatchObject({ balanced: true, outByMinor: 0, journalsInPeriod: 2, journalsBroughtForward: 1, unclassified: ['capital', 'expense'] });
  });
  it('says by how much it is out when a journal does not balance — never balances itself', () => {
    const tb = trialBalance('2026-10', [...journals, j('bad', '2026-10', [['cash', 100, 0], ['sales', 0, 90]])]);
    expect(tb.balanced).toBe(false);
    expect(tb.outByMinor).toBe(10);
  });
});

describe('the centre report ties to the ledger (M23-FR-01)', () => {
  it('splits shared paise exactly by largest remainder — nothing lost or made', () => {
    const split = splitByWeights(100, [{ centre: 'a', weightMinor: 1 }, { centre: 'b', weightMinor: 1 }, { centre: 'c', weightMinor: 1 }]);
    expect([...split.values()].reduce((s, v) => s + v, 0)).toBe(100);
    expect(split.get('a')).toBe(34);
    const huge = splitByWeights(9_999_999_999, [{ centre: 'x', weightMinor: 7_777_777_777 }, { centre: 'y', weightMinor: 3 }]);
    expect((huge.get('x') ?? 0) + (huge.get('y') ?? 0)).toBe(9_999_999_999);
  });
  it('places whole, shared, named and unassigned journals, and every account ties', () => {
    const journals = [
      j('d1', '2026-10', [['cash', 3_001, 0], ['sales', 0, 3_001]]),
      j('d2', '2026-10', [['cash', 1_000, 0], ['sales', 0, 1_000]]),
      j('n1', '2026-10', [['expense', 500, 0, 'dept-1'], ['cash', 0, 500, 'dept-1']]),
      j('u1', '2026-10', [['expense', 70, 0], ['cash', 0, 70]]),
    ];
    const r = centreReport({
      period: '2026-10', journals, classes: { sales: 'income', expense: 'expense' },
      attributionOf: (x) => x.entryId === 'd1' ? { kind: 'shared', shares: [{ centre: 's1', weightMinor: 2 }, { centre: 's2', weightMinor: 1 }], basis: 'sources' }
        : x.entryId === 'd2' ? { kind: 'whole', centre: 's1', basis: 'its store' } : { kind: 'unassigned', reason: 'no store' },
    });
    expect(r.ties).toBe(true);
    expect(r.centres.map((c) => [c.centre, c.profitMinor])).toEqual([['dept-1', -500], ['s1', 2_001 + 1_000], ['s2', 1_000]]);
    expect(r.unassigned.journals).toEqual([{ entryId: 'u1', reason: 'no store' }]);
    expect(r.tie.find((t) => t.account === 'cash')).toEqual({ account: 'cash', ledgerDebitMinor: 4_001, ledgerCreditMinor: 570, centresDebitMinor: 4_001, centresCreditMinor: 570 });
    expect(r.attributedBps).toBe(Math.round(((4_571 - 70) * 10_000) / 4_571));
  });
});

describe('rebate accruals re-measured down post the mirror (D10-FR-04)', () => {
  const map = { rules: [{ kind: 'supplier_rebate_accrual', legs: [{ account: 'rebate_receivable', side: 'debit' as const, component: 'amount' }, { account: 'rebate_income', side: 'credit' as const, component: 'amount' }] }] };
  const scheme = { schemeId: 'rb', supplierId: 's', basis: 'purchase_value' as const, rateBp: 100, startsOn: '2026-01-01', endsOn: '2026-12-31', approvedBy: 'u-ok' };
  it('posts the difference, then a compensating journal when the register re-measures lower', async () => {
    const journals: RebateAccrualJournal[] = [];
    let accrued = 5_000;
    const route = rebateAccrualRoutes({
      postingMap: () => map, schemes: () => [scheme], accruedFor: () => accrued, accrualJournals: () => journals, receiptJournals: () => [],
      periodStates: () => new Map(), nextOpenPeriod: () => '2026-11', appendJournal: (_t, e) => { journals.push(e as RebateAccrualJournal); },
      now: () => '2026-10-15T06:00:00.000Z', shopDayOf: (iso) => iso.slice(0, 10),
    }).find((r) => r.path === '/v1/finance/rebate-accruals/post')!;
    const ctx = { tenantId: 't', userId: 'u-acct', params: {}, query: {}, body: {} } as unknown as Parameters<typeof route.handler>[0];
    await route.handler(ctx);
    accrued = 3_500; // a bill was reversed: the register now says less was earned
    await route.handler(ctx);
    expect(journals.map((x) => [x.entryId, x.rebateAccrual.deltaMinor, x.lines.find((l) => l.accountCode === 'rebate_income')!.debitMinor])).toEqual([
      ['rebate-accrual:rb:1', 5_000, 0], ['rebate-accrual:rb:2', -1_500, 1_500],
    ]);
    expect(rebateAccrualPosition({ schemes: [scheme], accrued: new Map([['rb', 3_500]]), accruals: journals, receipts: [], accounts: { receivable: 'rebate_receivable', income: 'rebate_income' } })[0])
      .toMatchObject({ ledgerAccruedMinor: 3_500, ledgerReceivableMinor: 3_500, agrees: true, toPostMinor: 0 });
  });
});

describe('supplier advance positions (D10-FR-01)', () => {
  const adv = (change: 'paid' | 'applied', amountMinor: number, extra: Partial<SupplierAdvanceJournal['supplierAdvance']> = {}): SupplierAdvanceJournal => ({
    entryId: `x-${Math.random()}`, period: '2026-10', documentDate: '2026-10-01', narrative: 'n', lines: [], postedBy: 'u',
    supplierAdvance: { change, advanceId: 'a1', supplierId: 's1', amountMinor, on: '2026-10-01', ...extra },
  });
  it('left is paid less applied, a reversal giving back what it undoes', () => {
    const js = [adv('paid', 1_000), adv('applied', 400, { applicationId: 'p1' }), adv('applied', 100, { applicationId: 'r1', reverses: 'p1' })];
    expect(advancePositions(js)[0]).toMatchObject({ paidMinor: 1_000, appliedMinor: 300, leftMinor: 700 });
    expect(appliedForSupplier(js, 's1')).toBe(300);
    expect(appliedForSupplier(js, 'other')).toBe(0);
  });
});
