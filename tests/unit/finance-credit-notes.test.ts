import { describe, it, expect } from 'vitest';
import * as finance from '../../packages/finance/src/index';
import {
  issueCreditNote,
  buildReturnsReport,
  reconcileNotes,
  taxAdjustmentDeadline,
  type SourceInvoice,
  type ReturnLine,
  type CreditNote,
} from '../../packages/finance/src/credit-notes';

// M23-FR-02 remainder: credit/debit notes and returns reports.

const INVOICE: SourceInvoice = {
  invoiceId: 'inv-1',
  number: 'INV00042',
  customerId: 'c-school',
  issuedOn: '2026-07-10',
  taxableMinor: 1_000_000,
  taxes: [
    { component: 'CGST', rateBps: 250, amountMinor: 25_000 },
    { component: 'SGST', rateBps: 250, amountMinor: 25_000 },
  ],
  grossMinor: 1_050_000,
  financialYear: '2026-27',
};

function issue(over: Partial<Parameters<typeof issueCreditNote>[0]> = {}) {
  return issueCreditNote({
    noteId: 'cn-1', number: 'CN00001', kind: 'credit_note', invoice: INVOICE,
    customerId: 'c-school', reason: 'goods_returned',
    taxableMinor: 200_000,
    taxes: [
      { component: 'CGST', rateBps: 250, amountMinor: 5_000 },
      { component: 'SGST', rateBps: 250, amountMinor: 5_000 },
    ],
    issuedOn: '2026-08-04', ...over,
  });
}

describe('a credit note undoes an invoice WITHOUT editing it (CGST s.34, hard rule #2)', () => {
  it('issues against the invoice and declares it in the month it was ISSUED', () => {
    const r = issue();
    expect(r.issued).toBe(true);
    expect(r.note?.againstInvoiceNumber).toBe('INV00042');
    // Not 2026-07, the invoice's month. This is the rule people get wrong.
    expect(r.note?.declareInPeriod).toBe('2026-08');
    expect(r.note?.grossMinor).toBe(210_000);
  });

  it('EXPOSES NO FUNCTION that could edit an invoice', () => {
    // Absence as a control: there is no route to the forbidden correction.
    const named = Object.keys(finance);
    for (const forbidden of ['editInvoice', 'amendInvoice', 'reissueInvoice', 'updateInvoiceTotal']) {
      expect(named).not.toContain(forbidden);
    }
  });

  it('REFUSES to credit more than the invoice charged, cumulatively', () => {
    const r = issue({ taxableMinor: 900_000, alreadyCreditedMinor: 200_000,
      taxes: [
        { component: 'CGST', rateBps: 250, amountMinor: 22_500 },
        { component: 'SGST', rateBps: 250, amountMinor: 22_500 },
      ],
    });
    expect(r.outcome).toBe('exceeds_invoice');
    expect(r.detail).toContain('a payment out dressed as an adjustment');
  });

  it('allows a second note up to the remaining balance', () => {
    const r = issue({
      noteId: 'cn-2', number: 'CN00002', taxableMinor: 800_000, alreadyCreditedMinor: 200_000,
      taxes: [
        { component: 'CGST', rateBps: 250, amountMinor: 20_000 },
        { component: 'SGST', rateBps: 250, amountMinor: 20_000 },
      ],
    });
    expect(r.issued).toBe(true);
  });

  it('REFUSES to reverse the goods and keep the tax', () => {
    const r = issue({ taxes: [{ component: 'CGST', rateBps: 250, amountMinor: 5_000 }] });
    expect(r.outcome).toBe('tax_not_proportionate');
    // The error survives audits because the document's own totals still add up.
    expect(r.detail).toContain("the document's own totals still add up");
  });

  it('refuses tax reversed in the wrong proportion', () => {
    const r = issue({
      taxes: [
        { component: 'CGST', rateBps: 250, amountMinor: 25_000 },
        { component: 'SGST', rateBps: 250, amountMinor: 25_000 },
      ],
    });
    expect(r.outcome).toBe('tax_not_proportionate');
  });

  it('refuses to reverse a tax that was never charged', () => {
    const r = issue({
      taxes: [
        { component: 'CGST', rateBps: 250, amountMinor: 5_000 },
        { component: 'SGST', rateBps: 250, amountMinor: 5_000 },
        { component: 'IGST', rateBps: 500, amountMinor: 10_000 },
      ],
    });
    expect(r.outcome).toBe('tax_not_proportionate');
    expect(r.detail).toContain('was never charged');
  });

  it('refuses a note for another customer, or for nothing', () => {
    expect(issue({ customerId: 'c-caterer' }).outcome).toBe('wrong_customer');
    expect(issue({ taxableMinor: 0 }).outcome).toBe('zero_value');
  });
});

describe('the section 34(2) deadline is stated, not discovered', () => {
  it('computes 30 November following the year end', () => {
    expect(taxAdjustmentDeadline('2026-27')).toBe('2027-11-30');
    expect(taxAdjustmentDeadline('2025-26')).toBe('2026-11-30');
  });

  it('adjusts tax inside the window', () => {
    expect(issue().note?.taxAdjustable).toBe(true);
  });

  it('ISSUES the note outside the window but says the tax cannot be reclaimed', () => {
    const r = issue({ issuedOn: '2027-12-15' });
    expect(r.issued).toBe(true);
    // Commercially valid, fiscally not — and the difference is said out loud.
    expect(r.note?.taxAdjustable).toBe(false);
    expect(r.detail).toContain('tax NOT reclaimable');
    expect(r.note?.detail).toContain('CGST s.34(2)');
  });

  it('treats the deadline day itself as inside the window', () => {
    expect(issue({ issuedOn: '2027-11-30' }).note?.taxAdjustable).toBe(true);
    expect(issue({ issuedOn: '2027-12-01' }).note?.taxAdjustable).toBe(false);
  });
});

const line = (over: Partial<ReturnLine>): ReturnLine => ({
  returnId: 'r-1', invoiceId: 'inv-1', productId: 'p-atta', productName: 'Atta 5kg',
  departmentId: 'd-grocery', reason: 'goods_returned', qty: 1, taxableMinor: 26_500,
  returnedOn: '2026-08-02', creditNoteId: 'cn-1', ...over,
});

describe('a returns report is split by REASON, because a total is unactionable', () => {
  const LINES = [
    line({ returnId: 'r-1' }),
    line({ returnId: 'r-2', reason: 'price_correction', taxableMinor: 52_000, productId: 'p-oil', productName: 'Oil 1L' }),
    line({ returnId: 'r-3', reason: 'price_correction', taxableMinor: 30_000, productId: 'p-oil', productName: 'Oil 1L' }),
    line({ returnId: 'r-4', reason: 'deficiency_in_service', taxableMinor: 12_000, departmentId: 'd-cafe' }),
  ];

  it('names who each reason is a conversation with', () => {
    const report = buildReturnsReport({ lines: LINES, from: '2026-08-01', to: '2026-08-31' });
    expect(report.byReason[0]?.reason).toBe('price_correction');
    expect(report.byReason[0]?.owner).toContain('a price was wrong at the till');
    expect(report.byReason.find((r) => r.reason === 'deficiency_in_service')?.owner).toBe('the service desk');
    expect(report.detail).toContain('belongs to');
  });

  it('SURFACES returns with no credit note — money owed and not in the books', () => {
    const report = buildReturnsReport({
      lines: [...LINES, line({ returnId: 'r-5', taxableMinor: 40_000, creditNoteId: undefined })],
      from: '2026-08-01', to: '2026-08-31',
    });
    expect(report.uncreditedMinor).toBe(40_000);
    expect(report.uncredited).toEqual(['r-5']);
    // Invisible to any report built from credit notes — the note is the thing missing.
    expect(report.detail).toContain('invisible to any report built from credit notes');
  });

  it('breaks down by department', () => {
    const report = buildReturnsReport({ lines: LINES, from: '2026-08-01', to: '2026-08-31' });
    expect(report.byDepartment[0]?.departmentId).toBe('d-grocery');
    expect(report.byDepartment.find((d) => d.departmentId === 'd-cafe')?.valueMinor).toBe(12_000);
  });

  it('flags a product returned often enough to be a PRODUCT problem', () => {
    const many = Array.from({ length: 6 }, (_, n) =>
      line({ returnId: `r-x${n}`, productId: 'p-kettle', productName: 'Electric kettle' }));
    const report = buildReturnsReport({ lines: [...LINES, ...many], from: '2026-08-01', to: '2026-08-31' });
    expect(report.repeatOffenders[0]?.productName).toBe('Electric kettle');
    expect(report.repeatOffenders[0]?.lines).toBe(6);
    // Two returns of the same oil is customers; six kettles is the kettle.
    expect(report.repeatOffenders.map((r) => r.productId)).not.toContain('p-oil');
  });

  it('ignores returns outside the window', () => {
    const report = buildReturnsReport({
      lines: [...LINES, line({ returnId: 'r-old', returnedOn: '2026-06-01', taxableMinor: 999_000 })],
      from: '2026-08-01', to: '2026-08-31',
    });
    expect(report.totalValueMinor).toBe(120_500);
  });

  it('says so plainly when there were none', () => {
    expect(buildReturnsReport({ lines: [], from: '2026-08-01', to: '2026-08-31' }).detail)
      .toBe('no returns recorded in this window');
  });
});

describe('notes reconcile to the ledger for the period they were ISSUED in', () => {
  const note = issue().note!;
  const late = issue({ noteId: 'cn-late', number: 'CN00009', issuedOn: '2027-12-15' }).note!;

  it('reconciles exactly', () => {
    const r = reconcileNotes({
      period: '2026-08', notes: [note], ledgerTaxableMinor: 200_000, ledgerTaxMinor: 10_000,
    });
    expect(r.reconciles).toBe(true);
    expect(r.notesIssued).toBe(1);
  });

  it('names a difference the buyer would find first', () => {
    const r = reconcileNotes({
      period: '2026-08', notes: [note], ledgerTaxableMinor: 180_000, ledgerTaxMinor: 10_000,
    });
    expect(r.reconciles).toBe(false);
    expect(r.differenceMinor).toBe(20_000);
    expect(r.detail).toContain("GSTR-2B will find before we do");
  });

  it('keeps an out-of-window note OUT of the tax figures but visible', () => {
    const r = reconcileNotes({
      period: '2027-12', notes: [late], ledgerTaxableMinor: 0, ledgerTaxMinor: 0,
    });
    expect(r.creditedTaxableMinor).toBe(0);
    expect(r.outsideTaxWindowMinor).toBe(200_000);
    expect(r.detail).toContain('carries no tax relief');
  });

  it('never counts a note from another period', () => {
    const other: CreditNote = { ...note, declareInPeriod: '2026-09' };
    const r = reconcileNotes({ period: '2026-08', notes: [other], ledgerTaxableMinor: 0, ledgerTaxMinor: 0 });
    expect(r.notesIssued).toBe(0);
    expect(r.reconciles).toBe(true);
  });
});

describe('a debit note works the same way, in the other direction', () => {
  it('is not capped by the invoice, because it ADDS to what was billed', () => {
    const r = issue({
      noteId: 'dn-1', number: 'DN00001', kind: 'debit_note', reason: 'price_correction',
      taxableMinor: 1_200_000, alreadyCreditedMinor: 0,
      taxes: [
        { component: 'CGST', rateBps: 250, amountMinor: 30_000 },
        { component: 'SGST', rateBps: 250, amountMinor: 30_000 },
      ],
    });
    expect(r.issued).toBe(true);
    expect(r.note?.kind).toBe('debit_note');
  });
});
