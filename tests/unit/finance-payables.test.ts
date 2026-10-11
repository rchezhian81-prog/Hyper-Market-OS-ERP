import { describe, it, expect } from 'vitest';
import {
  planPayablesPostings, postPayables, reconcilePayables, payablesControlAccount, ledgerHolds,
  DEFAULT_RETAIL_POSTING_MAP, PAYABLES_POSTING_RULES, validatePostingMap,
  type PayablesAccount, type PostedPayablesJournal, type PostingMap,
} from '../../packages/finance/src/index';

/**
 * SP-7b (M23-FR-01 · F04's payable half · hard rule #2 · P-08 · QG-07): the pure payables engine. It posts the DIFFERENCE
 * between what the purchase register says a supplier is owed and what the ledger already holds — an accrual when the
 * matched payable rose, a reversal (its own journal) when it fell, a debit note once — through the accountant's mapping;
 * an unmapped kind is a named exception; the reconciliation compares the register with the ledger as two figures reached
 * two different ways and lists exactly what is unposted.
 */

const account = (over: Partial<PayablesAccount> = {}): PayablesAccount => ({
  supplierId: 's-1',
  invoices: [{ invoiceId: 'inv-1', payableMinor: 7000, matched: true, matchedAt: '2026-09-30T10:00:00.000Z' }],
  debitNotes: [{ debitNoteRef: 'DN-grn-1-L1', valueMinor: 1500, decidedAt: '2026-09-30T11:00:00.000Z' }],
  payments: [],
  ...over,
});
type Kind = 'supplier_invoice' | 'supplier_invoice_reversal' | 'supplier_debit_note' | 'supplier_payment';
const posted = (kind: Kind, sourceId: string, amount: number, supplierId = 's-1'): PostedPayablesJournal => ({
  kind, sourceKind: kind === 'supplier_debit_note' ? 'supplier_debit_note' : kind === 'supplier_payment' ? 'supplier_payment' : 'supplier_invoice', sourceId, supplierId,
  components: kind === 'supplier_invoice' ? { payable: amount } : { amount },
  lines: kind === 'supplier_invoice'
    ? [{ accountCode: 'purchases_grni', debitMinor: amount, creditMinor: 0 }, { accountCode: 'supplier_payable', debitMinor: 0, creditMinor: amount }]
    : [{ accountCode: 'supplier_payable', debitMinor: amount, creditMinor: 0 }, { accountCode: kind === 'supplier_payment' ? 'bank_clearing' : 'purchases_grni', debitMinor: 0, creditMinor: amount }],
});

describe('planPayablesPostings — the ledger is brought level with the register, never past it', () => {
  it('a first run accrues the matched payable and raises the debit note, dated by the match and the disposition; an unmatched invoice posts nothing', () => {
    const plan = planPayablesPostings([account({ invoices: [...account().invoices, { invoiceId: 'inv-9', payableMinor: 0, matched: false, matchedAt: null }] })], []);
    expect(plan).toEqual([
      { kind: 'supplier_invoice', sourceKind: 'supplier_invoice', sourceId: 'inv-1', supplierId: 's-1', documentDate: '2026-09-30', components: { payable: 7000, taxable: 7000, cgst: 0, sgst: 0, igst: 0 } },
      { kind: 'supplier_debit_note', sourceKind: 'supplier_debit_note', sourceId: 'DN-grn-1-L1', supplierId: 's-1', documentDate: '2026-09-30', components: { amount: 1500, taxable: 1500, cgst: 0, sgst: 0, igst: 0 } },
    ]);
  });

  it('a re-run over a ledger that already holds the figures posts nothing; a payable that ROSE accrues the difference; one that FELL reverses it as its own journal; a debit note never posts twice', () => {
    const level = [posted('supplier_invoice', 'inv-1', 7000), posted('supplier_debit_note', 'DN-grn-1-L1', 1500)];
    expect(planPayablesPostings([account()], level)).toEqual([]);
    const rose = planPayablesPostings([account({ invoices: [{ invoiceId: 'inv-1', payableMinor: 9000, matched: true, matchedAt: '2026-10-01T10:00:00.000Z' }] })], level);
    expect(rose).toEqual([{ kind: 'supplier_invoice', sourceKind: 'supplier_invoice', sourceId: 'inv-1', supplierId: 's-1', documentDate: '2026-10-01', components: { payable: 2000, taxable: 2000, cgst: 0, sgst: 0, igst: 0 } }]);
    const fell = planPayablesPostings([account({ invoices: [{ invoiceId: 'inv-1', payableMinor: 5000, matched: true, matchedAt: '2026-10-01T10:00:00.000Z' }] })], level);
    expect(fell).toEqual([{ kind: 'supplier_invoice_reversal', sourceKind: 'supplier_invoice', sourceId: 'inv-1', supplierId: 's-1', documentDate: '2026-10-01', components: { amount: 2000, taxable: 2000, cgst: 0, sgst: 0, igst: 0 } }]);
    // The ledger's view of the invoice after accrual + reversal is the net.
    expect(ledgerHolds([...level, posted('supplier_invoice_reversal', 'inv-1', 2000)], 'supplier_invoice', 'inv-1')).toBe(5000);
    expect(ledgerHolds(level, 'supplier_debit_note', 'DN-grn-1-L1')).toBe(1500);
  });

  it('SP-7c: a payment posts ONCE at its amount, dated the day the money went, settles the supplier through the bank clearing, and nets the register in the reconciliation', () => {
    const paid = account({ payments: [{ paymentId: 'pay-1', amountMinor: 3000, paidOn: '2026-10-02' }] });
    const level = [posted('supplier_invoice', 'inv-1', 7000), posted('supplier_debit_note', 'DN-grn-1-L1', 1500)];
    const plan = planPayablesPostings([paid], level);
    expect(plan).toEqual([{ kind: 'supplier_payment', sourceKind: 'supplier_payment', sourceId: 'pay-1', supplierId: 's-1', documentDate: '2026-10-02', components: { amount: 3000 } }]);
    const out = postPayables(plan, DEFAULT_RETAIL_POSTING_MAP, 'INR');
    expect(out.exceptions).toEqual([]);
    expect(out.journals[0]!.entry.lines.map((l) => [l.account, l.side, l.amount.minor])).toEqual([['supplier_payable', 'debit', 3000], ['bank_clearing', 'credit', 3000]]);
    const after = [...level, posted('supplier_payment', 'pay-1', 3000)];
    expect(planPayablesPostings([paid], after)).toEqual([]);
    expect(ledgerHolds(after, 'supplier_payment', 'pay-1')).toBe(3000);
    // Register: 7000 − 1500 − 3000 = 2500; ledger: the control account nets to the same.
    expect(reconcilePayables([paid], after, DEFAULT_RETAIL_POSTING_MAP)).toMatchObject({ registerOwedMinor: 2500, ledgerOwedMinor: 2500, agrees: true });
    expect(reconcilePayables([paid], level, DEFAULT_RETAIL_POSTING_MAP)).toMatchObject({ registerOwedMinor: 2500, ledgerOwedMinor: 5500, differenceMinor: -3000, agrees: false });
  });
});

describe('postPayables — through the mapping, or a named exception', () => {
  it('the suggested mapping carries the three payables rules and posts balanced journals: the supplier credited, the clearing debited; the debit note the mirror image', () => {
    expect(validatePostingMap(DEFAULT_RETAIL_POSTING_MAP)).toMatchObject({ ok: true });
    expect(DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => PAYABLES_POSTING_RULES.some((p) => p.kind === r.kind))).toEqual(PAYABLES_POSTING_RULES);
    expect(payablesControlAccount(DEFAULT_RETAIL_POSTING_MAP)).toBe('supplier_payable');
    const out = postPayables(planPayablesPostings([account()], []), DEFAULT_RETAIL_POSTING_MAP, 'INR');
    expect(out.exceptions).toEqual([]);
    expect(out.journals.map((j) => [j.posting.kind, j.entry.balanced, j.entry.lines.map((l) => [l.account, l.side, l.amount.minor])])).toEqual([
      ['supplier_invoice', true, [['purchases_grni', 'debit', 7000], ['supplier_payable', 'credit', 7000]]],
      ['supplier_debit_note', true, [['supplier_payable', 'debit', 1500], ['purchases_grni', 'credit', 1500]]],
    ]);
  });

  it('a mapping that does not name a kind yields a VISIBLE exception for that source and still posts the rest', () => {
    const noNotes: PostingMap = { rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => r.kind !== 'supplier_debit_note') };
    const out = postPayables(planPayablesPostings([account()], []), noNotes, 'INR');
    expect(out.journals.map((j) => j.posting.kind)).toEqual(['supplier_invoice']);
    expect(out.exceptions).toEqual([expect.objectContaining({ kind: 'supplier_debit_note', sourceIds: ['DN-grn-1-L1'], supplierId: 's-1', reason: 'unmapped_kind' })]);
    expect(out.exceptions[0]!.detail).toContain('DN-grn-1-L1');
  });
});

describe('reconcilePayables — two figures, two derivations, the difference always visible', () => {
  it('before posting the ledger holds nothing and the difference is the register, with the unposted listed; after posting they agree', () => {
    const before = reconcilePayables([account()], [], DEFAULT_RETAIL_POSTING_MAP);
    expect(before).toMatchObject({ controlAccount: 'supplier_payable', registerOwedMinor: 5500, ledgerOwedMinor: 0, differenceMinor: 5500, agrees: false });
    expect(before.suppliers[0]!.unposted.map((p) => p.kind)).toEqual(['supplier_invoice', 'supplier_debit_note']);
    expect(before.leftDerivation).not.toBe(before.rightDerivation);
    const after = reconcilePayables([account()], [posted('supplier_invoice', 'inv-1', 7000), posted('supplier_debit_note', 'DN-grn-1-L1', 1500)], DEFAULT_RETAIL_POSTING_MAP);
    expect(after).toMatchObject({ registerOwedMinor: 5500, ledgerOwedMinor: 5500, differenceMinor: 0, agrees: true, suppliers: [{ supplierId: 's-1', agrees: true, unposted: [] }] });
  });

  it('with no mapping, or one naming no control account, nothing agrees and the account is null — not a zero that reads as reconciled', () => {
    expect(reconcilePayables([account()], [], undefined)).toMatchObject({ controlAccount: null, agrees: false, suppliers: [{ agrees: false }] });
    const noControl: PostingMap = { rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => r.kind !== 'supplier_invoice') };
    expect(reconcilePayables([account()], [posted('supplier_invoice', 'inv-1', 7000)], noControl)).toMatchObject({ controlAccount: null, agrees: false });
    // Per supplier, a second supplier out of step does not hide behind a first that agrees.
    const two = reconcilePayables(
      [account(), account({ supplierId: 's-2', invoices: [{ invoiceId: 'inv-2', payableMinor: 100, matched: true, matchedAt: '2026-09-30T10:00:00.000Z' }], debitNotes: [] })],
      [posted('supplier_invoice', 'inv-1', 7000), posted('supplier_debit_note', 'DN-grn-1-L1', 1500)], DEFAULT_RETAIL_POSTING_MAP,
    );
    expect(two.suppliers.map((s) => [s.supplierId, s.agrees, s.differenceMinor])).toEqual([['s-1', true, 0], ['s-2', false, 100]]);
    expect(two).toMatchObject({ agrees: false, differenceMinor: 100 });
  });
});
