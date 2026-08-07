import { describe, it, expect } from 'vitest';
import {
  reconcileSupplierStatement, supplierPosition, balanceOf, EFFECT_ON_WHAT_WE_OWE,
  type LedgerItem, type SupplierReconciliation,
} from '../../packages/migration/src/supplier-reconciliation';

// MG-06, OB-06, §34 — proving what we owe against the one external record that is genuinely
// obtainable: the supplier's own ledger. They keep it for their own reasons and they want paying.

const STATEMENT_DATE = '2026-07-31';

/** A realistic month: one agreed invoice, one the two sides read differently, a payment in
 *  transit, a stale payment, and an invoice we have never seen. */
const OURS: readonly LedgerItem[] = [
  { documentNumber: 'INV-1001', kind: 'invoice', amountMinor: 500_000, documentDate: '2026-06-10' },
  { documentNumber: 'INV-1002', kind: 'invoice', amountMinor: 340_000, documentDate: '2026-07-05' },
  { documentNumber: 'PAY-9001', kind: 'payment', amountMinor: 45_000, documentDate: '2026-07-29' },
  { documentNumber: 'PAY-8000', kind: 'payment', amountMinor: 12_000, documentDate: '2026-03-01' },
];

const THEIRS: readonly LedgerItem[] = [
  { documentNumber: 'INV-1001', kind: 'invoice', amountMinor: 500_000, documentDate: '2026-06-10' },
  { documentNumber: 'INV-1002', kind: 'invoice', amountMinor: 345_000, documentDate: '2026-07-05' },
  { documentNumber: 'INV-1003', kind: 'invoice', amountMinor: 88_000, documentDate: '2026-05-20' },
];

const reconcile = (over: Partial<Parameters<typeof reconcileSupplierStatement>[0]> = {}) =>
  reconcileSupplierStatement({
    supplierId: 'SUP-ANNAPOORNA', statementDate: STATEMENT_DATE,
    ourItems: OURS, theirItems: THEIRS, ...over,
  });

const item = (r: SupplierReconciliation, documentNumber: string) =>
  r.items.find((i) => i.documentNumber === documentNumber)!;

describe('direction is declared, never inferred from a sign on an amount', () => {
  it('states what each kind of document does to what we owe', () => {
    // A signed amount read off a statement is exactly where the mirror-image mistake gets in:
    // our payable is their receivable, and a reconciliation that reads one side backwards
    // agrees perfectly at twice the true figure.
    expect(EFFECT_ON_WHAT_WE_OWE.invoice).toBe(1);
    expect(EFFECT_ON_WHAT_WE_OWE.credit_note).toBe(-1);
    expect(EFFECT_ON_WHAT_WE_OWE.payment).toBe(-1);
  });

  it('projects a balance from the items rather than carrying one', () => {
    expect(balanceOf(OURS)).toBe(500_000 + 340_000 - 45_000 - 12_000);
    expect(balanceOf([])).toBe(0);
  });

  it('THE MIRROR CHECK: the items sum to the headline difference, exactly', () => {
    // One sign convention across all four statuses. If any one of them is mirrored, this fails —
    // and it is the only assertion here that would catch reading a payment as a receipt.
    const r = reconcile();
    const summed = r.items.reduce((t, i) => t + i.differenceMinor, 0);
    expect(summed).toBe(r.differenceMinor);
    expect(r.differenceMinor).toBe(r.theirBalanceMinor - r.ourBalanceMinor);
    expect(r.differenceMinor).toBeGreaterThan(0); // they say we owe more, which is the usual case
  });
});

describe('telling a timing difference from a real one', () => {
  const r = reconcile();

  it('accepts timing as the explanation for a payment made days before the statement', () => {
    const paid = item(r, 'PAY-9001');
    expect(paid.status).toBe('only_in_our_books');
    expect(paid.timing).toBe('plausibly_timing');
    expect(paid.detail).toContain('payment in transit');
    // We paid on the 29th; they banked it on the 2nd. Neither side is wrong.
    expect(paid.differenceMinor).toBe(45_000);
  });

  it('refuses timing for a payment still missing five months later', () => {
    const stale = item(r, 'PAY-8000');
    expect(stale.timing).toBe('too_old_for_timing');
    expect(stale.detail).toContain('either they never received it');
  });

  it('NEVER calls a disputed amount timing, because both sides hold the document', () => {
    // A timing difference is one side not having seen the paper yet. Here both have it and read
    // it differently — that is a price, a quantity or a tax, and it does not clear by itself.
    const disputed = item(r, 'INV-1002');
    expect(disputed.status).toBe('amount_differs');
    expect(disputed.timing).toBe('not_applicable');
    expect(disputed.differenceMinor).toBe(5_000);
    expect(disputed.detail).toContain('settled by looking at the delivery note');
  });

  it('takes the timing window from configuration, not from a number in the code', () => {
    const tight = reconcile({ timingWindowDays: 1 });
    expect(item(tight, 'PAY-9001').timing).toBe('too_old_for_timing');
    const loose = reconcile({ timingWindowDays: 200 });
    expect(item(loose, 'PAY-8000').timing).toBe('plausibly_timing');
  });
});

describe('the dangerous direction is theirs, not ours', () => {
  const r = reconcile();

  it('flags an invoice only they have as an understatement risk', () => {
    const unseen = item(r, 'INV-1003');
    expect(unseen.status).toBe('only_on_their_statement');
    expect(unseen.kind).toBe('invoice');
    expect(r.understatementRiskMinor).toBe(88_000);
    // Overstating what we owe gets caught by us. Understating it gets caught by nobody until
    // they chase, by which time it is in the opening balance and the CA has signed it.
    expect(unseen.detail).toContain('we open owing nothing for it');
  });

  it('sorts it FIRST, above larger differences that are merely wrong', () => {
    // INV-1002 differs and PAY-9001 is bigger in value, but neither can leave us opening at zero
    // for a real liability.
    expect(r.items[0]?.documentNumber).toBe('INV-1003');
  });

  it('names the amount in the owner action, ahead of everything else', () => {
    expect(r.ownerAction).toContain('88000');
    expect(r.ownerAction).toContain('before the opening balance is signed');
  });

  it('does not treat a credit note only they have as an understatement risk', () => {
    const credited = reconcile({
      theirItems: [
        ...THEIRS.filter((i) => i.documentNumber !== 'INV-1003'),
        { documentNumber: 'CN-77', kind: 'credit_note', amountMinor: 88_000, documentDate: '2026-05-20' },
      ],
    });
    expect(credited.understatementRiskMinor).toBe(0);
    // A credit they have given us and we have not recorded is in our favour, and it still shows.
    expect(item(credited, 'CN-77').differenceMinor).toBe(-88_000);
    expect(credited.reconciles).toBe(false);
  });
});

describe('nothing is netted', () => {
  it('a difference of zero does not mean the two ledgers agree', () => {
    // Our unapplied payment and their unrecorded credit note are the same size and cancel exactly.
    // Netted, this supplier reports a clean zero and both problems disappear.
    const ourItems: readonly LedgerItem[] = [
      { documentNumber: 'INV-A', kind: 'invoice', amountMinor: 100_000, documentDate: '2026-01-10' },
      { documentNumber: 'PAY-P', kind: 'payment', amountMinor: 45_000, documentDate: '2026-01-20' },
    ];
    const theirItems: readonly LedgerItem[] = [
      { documentNumber: 'INV-A', kind: 'invoice', amountMinor: 100_000, documentDate: '2026-01-10' },
      { documentNumber: 'CN-X', kind: 'credit_note', amountMinor: 45_000, documentDate: '2026-01-25' },
    ];
    const r = reconcile({ ourItems, theirItems });

    expect(r.differenceMinor).toBe(0);
    expect(r.reconciles).toBe(false);
    expect(r.unexplainedMinor).toBe(90_000);
    expect(r.detail).toContain('netting them produces a clean zero that hides both');
  });

  it('reports what timing could explain and what it could not as two figures', () => {
    const r = reconcile();
    expect(r.plausiblyTimingMinor).toBe(45_000);            // PAY-9001
    expect(r.unexplainedMinor).toBe(5_000 + 12_000 + 88_000); // INV-1002, PAY-8000, INV-1003
    // Two fields, both named in the summary. Neither is offered on its own as "the difference",
    // because "out by 45,000" is the least useful answer available to the person settling it.
    expect(r.detail).toContain('45000');
    expect(r.detail).toContain('105000');
  });
});

describe('a supplier who agrees', () => {
  const r = reconcile({ ourItems: OURS, theirItems: OURS });

  it('reconciles item for item, not just in total', () => {
    expect(r.reconciles).toBe(true);
    expect(r.differenceMinor).toBe(0);
    expect(r.items.every((i) => i.status === 'agreed')).toBe(true);
    expect(r.unexplainedMinor).toBe(0);
    expect(r.understatementRiskMinor).toBe(0);
    expect(r.ownerAction).toBe('nothing — this supplier agrees with us item for item');
  });
});

describe('the position across every supplier', () => {
  const agreeing = reconcileSupplierStatement({
    supplierId: 'SUP-KUMAR', statementDate: STATEMENT_DATE, ourItems: OURS, theirItems: OURS,
  });

  it('NAMES a supplier who never replied instead of counting them as agreeing', () => {
    // Silence is the commonest response to a statement request and the easiest to read as
    // consent. The balance it leaves unproved goes into the opening books either way.
    const p = supplierPosition({
      reconciliations: [agreeing],
      suppliersAsked: ['SUP-KUMAR', 'SUP-VELAN', 'SUP-ARUL'],
    });
    expect(p.noStatementReceived).toEqual(['SUP-ARUL', 'SUP-VELAN']);
    expect(p.sufficientToVerify).toBe(false);
    expect(p.detail).toContain('2 never replied');
  });

  it('blocks on an understatement risk however small, and whatever the tolerance', () => {
    const p = supplierPosition({
      reconciliations: [agreeing, reconcile()],
      suppliersAsked: ['SUP-KUMAR', 'SUP-ANNAPOORNA'],
      toleranceMinor: 10_000_000,
    });
    expect(p.totalUnderstatementRiskMinor).toBe(88_000);
    expect(p.sufficientToVerify).toBe(false);
  });

  it('is satisfied only when every supplier replied and nothing is unexplained', () => {
    const p = supplierPosition({ reconciliations: [agreeing], suppliersAsked: ['SUP-KUMAR'] });
    expect(p.agreed).toBe(1);
    expect(p.withDifferences).toBe(0);
    expect(p.sufficientToVerify).toBe(true);
    expect(p.detail).toContain('not the old system\'s');
  });

  it('lets the owner set a tolerance for unexplained difference, but not for silence', () => {
    const small = reconcileSupplierStatement({
      supplierId: 'SUP-RAJA', statementDate: STATEMENT_DATE,
      ourItems: [{ documentNumber: 'INV-Z', kind: 'invoice', amountMinor: 100_000, documentDate: '2026-01-01' }],
      theirItems: [{ documentNumber: 'INV-Z', kind: 'invoice', amountMinor: 100_100, documentDate: '2026-01-01' }],
    });
    expect(small.unexplainedMinor).toBe(100);

    const within = supplierPosition({
      reconciliations: [small], suppliersAsked: ['SUP-RAJA'], toleranceMinor: 500,
    });
    expect(within.sufficientToVerify).toBe(true);

    const silent = supplierPosition({
      reconciliations: [small], suppliersAsked: ['SUP-RAJA', 'SUP-MUTHU'], toleranceMinor: 500,
    });
    expect(silent.sufficientToVerify).toBe(false);
  });
});
