import { describe, it, expect } from 'vitest';
import { reconcileBankStatement, type BankSupplierPayment } from '../../services/finance/src/bank-reconciliation';

/** U7 · OB-724 — a debit line is matched to a supplier payment by its reference, for exactly what left the account. Pure. */
const line = (lineId: string, amountMinor: number, reference: string, narrative?: string) => ({ lineId, date: '2026-11-12', amountMinor, reference, ...(narrative === undefined ? {} : { narrative }) });
const statement = (lines: ReturnType<typeof line>[]) => ({ statementId: 'S', accountRef: 'current', fromDate: '2026-11-01', toDate: '2026-11-30', openingMinor: 0, closingMinor: lines.reduce((n, l) => n + l.amountMinor, 0), lines }) as never;
const payment = (paymentId: string, amountMinor: number, reference: string, extra: Partial<BankSupplierPayment> = {}): BankSupplierPayment => ({ paymentId, supplierId: 's-1', amountMinor, paidOn: '2026-11-12', method: 'bank_transfer', reference, ...extra });
const kinds = (r: ReturnType<typeof reconcileBankStatement>) => r.lines.map((l) => [l.lineId, l.match.kind, 'paymentId' in l.match ? l.match.paymentId : null]);

describe('U7 · bank line matched to a supplier payment (pure)', () => {
  it('matches by reference (or narrative) and exact debit; counts it as matched', () => {
    const r = reconcileBankStatement({ statement: statement([line('1', -50_000, 'NEFT-1'), line('2', -20_000, 'X', 'paid UTR-9 to supplier')]), batches: [], deposits: [], exceptions: [], supplierPayments: [payment('p1', 50_000, 'NEFT-1'), payment('p2', 20_000, 'UTR-9')] });
    expect(kinds(r)).toEqual([['1', 'supplier_payment', 'p1'], ['2', 'supplier_payment', 'p2']]);
    expect(r.totals).toMatchObject({ matched: 2, matchedMinor: -70_000, unmatched: 0 });
  });

  it('never matches a different amount, a credit, a cash payment, or one payment twice', () => {
    const r = reconcileBankStatement({
      statement: statement([line('1', -40_000, 'NEFT-1'), line('2', 50_000, 'NEFT-1'), line('3', -50_000, 'NEFT-1'), line('4', -50_000, 'NEFT-1'), line('5', -10_000, 'CASH-1')]),
      batches: [], deposits: [], exceptions: [], supplierPayments: [payment('p1', 50_000, 'NEFT-1'), payment('c1', 10_000, 'CASH-1', { method: 'cash' })],
    });
    expect(kinds(r)).toEqual([['1', 'unmatched', null], ['2', 'unmatched', null], ['3', 'supplier_payment', 'p1'], ['4', 'unmatched', null], ['5', 'unmatched', null]]);
  });

  it('matches the NET that left the account when TDS was withheld', () => {
    const r = reconcileBankStatement({ statement: statement([line('1', -49_000, 'NEFT-2')]), batches: [], deposits: [], exceptions: [], supplierPayments: [payment('p1', 50_000, 'NEFT-2', { tds: { netMinor: 49_000 } })] });
    expect(kinds(r)).toEqual([['1', 'supplier_payment', 'p1']]);
  });

  it('with no supplier payments known, a debit line stays unmatched (as before)', () => {
    const r = reconcileBankStatement({ statement: statement([line('1', -50_000, 'NEFT-1')]), batches: [], deposits: [], exceptions: [] });
    expect(kinds(r)).toEqual([['1', 'unmatched', null]]);
  });
});
