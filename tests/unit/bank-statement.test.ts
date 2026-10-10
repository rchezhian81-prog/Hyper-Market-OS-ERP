import { describe, it, expect } from 'vitest';
import { parseBankStatementCsv, checkBankStatement } from '../../packages/finance/src/bank-statement';
import { monthEvidence } from '../../services/finance/src/independent-evidence';

// PF-12: a bank statement is independent evidence only if it reconciles to itself; the close's checks pair the books with
// the outside files and name what does not match.

const META = { statementId: 'ST-1', accountRef: 'HDFC-current-1', fromDate: '2026-09-01', toDate: '2026-09-30', openingMinor: 10_000 };

describe('reading a bank statement', () => {
  it('reads the bank\'s CSV (quoted thousands, DD/MM/YYYY, debit or credit), signed in paise', () => {
    const r = parseBankStatementCsv('Date,Narrative,Reference,Debit,Credit\n01/09/2026,"SETTLEMENT, ACQ",UTR1 PB-1,,"1,000.50"\n2026-09-02,Fee,F1,0.50,', { ...META, closingMinor: 10_000 + 100_050 - 50 });
    expect(r).toMatchObject({ ok: true, statement: { lines: [
      { lineId: 'ST-1:1', date: '2026-09-01', amountMinor: 100_050, reference: 'UTR1 PB-1', narrative: 'SETTLEMENT, ACQ' },
      { lineId: 'ST-1:2', date: '2026-09-02', amountMinor: -50, reference: 'F1', narrative: 'Fee' },
    ] } });
  });

  it.each([
    ['does not add up', 'Date,Reference,Debit,Credit\n01/09/2026,R,,10.00', { closingMinor: 1 }, /does not add up/],
    ['a line outside the period', 'Date,Reference,Debit,Credit\n01/10/2026,R,,10.00', { closingMinor: 11_000 }, /outside the statement's period/],
    ['a bad date', 'Date,Reference,Debit,Credit\n31/02/2026,R,,10.00', { closingMinor: 11_000 }, /not a date/],
    ['both debit and credit', 'Date,Reference,Debit,Credit\n01/09/2026,R,1.00,10.00', { closingMinor: 10_900 }, /not both/],
    ['no credit column', 'Date,Reference,Debit\n01/09/2026,R,1.00', { closingMinor: 9_900 }, /no credit column/],
    ['an account number as the reference', 'Date,Reference,Debit,Credit\n01/09/2026,R,,10.00', { closingMinor: 11_000, accountRef: '5010-0123-4567-89' }, /account number/],
  ])('refuses: %s', (_, csv, over, why) => {
    const r = parseBankStatementCsv(csv, { ...META, ...over });
    expect(r.ok).toBe(false);
    expect((r as { readonly problems: readonly string[] }).problems.join(' ')).toMatch(why);
  });

  it('checks a structured statement the same way', () => {
    expect(checkBankStatement({ ...META, closingMinor: 10_500, lines: [{ lineId: 'a', date: '2026-09-05', amountMinor: 500, reference: 'X' }] }).ok).toBe(true);
    expect(checkBankStatement({ ...META, closingMinor: 10_500, lines: [{ lineId: 'a', date: '2026-09-05', amountMinor: 250, reference: 'X' }, { lineId: 'a', date: '2026-09-05', amountMinor: 250, reference: 'X' }] }).ok).toBe(false);
  });
});

describe('the month\'s independent comparison', () => {
  const batch = { batchId: 'PB-1', providerId: 'p', settlementDate: '2026-09-02', declaredNetMinor: 990, lines: [{ id: 'l1', ref: 'PAY-1', amountMinor: 1_000 }] };
  it('pairs the tills\' card/UPI tenders with the settlement lines, and the payouts with the bank credits naming them', () => {
    const e = monthEvidence({
      period: '2026-09',
      tenders: [{ ref: 'PAY-1', kind: 'card', amountMinor: 1_000, saleId: 'S1' }, { ref: 'PAY-2', kind: 'upi', amountMinor: 300, saleId: 'S2' }, { ref: 'X', kind: 'cash', amountMinor: 50, saleId: 'S3' }],
      batches: [batch],
      statements: [{ ...META, closingMinor: 10_990, lines: [{ lineId: 'b1', date: '2026-09-02', amountMinor: 990, reference: 'UTR PB-1' }] }],
    });
    expect(e.checks.map((c) => [c.leftMinor, c.rightMinor])).toEqual([[1_300, 1_000], [990, 990]]);
    expect(e.checks[0]!.leftDerivation).not.toBe(e.checks[0]!.rightDerivation);
    expect(e.unsettledTenders.map((t) => t.ref)).toEqual(['PAY-2']);
    expect(e.payoutsNotInBank).toEqual([]);
  });
  it('a month with no electronic takings and no payouts has nothing to compare', () => {
    expect(monthEvidence({ period: '2026-10', tenders: [], batches: [batch], statements: [] }).checks).toEqual([]);
  });
});
