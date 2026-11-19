import { describe, it, expect } from 'vitest';
import { foldSupplierAccount, type ShelfReturnDebitNote, type ShelfDebitNoteAcceptance } from '../../services/purchase/src/supplier-account';
import { planPayablesPostings } from '../../packages/finance/src/index';
import { acceptanceBody } from '../../apps/web-erp/src/supplier-bills-to-the-books-session';

// OB-879 (batch 19 · under OB-874 C): "Supplier accepted" for a debit note on shelf stock returned to the supplier.

const note = (ref: string, valueMinor: number): ShelfReturnDebitNote => ({
  debitNoteRef: ref, number: `SDN/26-27/0000${ref.slice(-1)}`, supplierId: 'sup-1', returnId: `rts-${ref.slice(-1)}`, returnNumber: `RTS1/26-27/0000${ref.slice(-1)}`,
  productId: 'OIL', quantityMinor: 2, valueMinor, reason: 'expired', raisedAt: '2026-11-18T05:00:00.000Z', gstTreatment: 'not_decided', nettedInBalance: false,
});
const accepted = (ref: string, noteValueMinor: number, acceptedMinor: number): ShelfDebitNoteAcceptance => ({
  debitNoteRef: ref, supplierId: 'sup-1', supplierCreditNoteNo: 'CN-1', supplierCreditNoteDate: '2026-11-19', noteValueMinor, acceptedMinor,
  differenceMinor: noteValueMinor - acceptedMinor, ...(acceptedMinor < noteValueMinor ? { reason: 'part' } : {}), acceptedBy: 'u-acct', acceptedAt: '2026-11-19T06:00:00.000Z',
});
const fold = (acceptances: readonly ShelfDebitNoteAcceptance[]) => foldSupplierAccount({
  supplierId: 'sup-1', invoices: [], matchOf: () => undefined, orders: [], receipts: [],
  shelfReturnDebitNotes: [note('DN-1', 30_000), note('DN-2', 10_000)], shelfDebitNoteAcceptances: acceptances, asAt: '2026-11-19T07:00:00.000Z',
});

describe('OB-879 — the supplier account folds a shelf-return debit note\'s acceptance', () => {
  it('a waiting note is shown and not netted', () => {
    const a = fold([]);
    expect(a.shelfReturnDebitNotes.map((d) => [d.state, d.nettedInBalance])).toEqual([['waiting_for_supplier', false], ['waiting_for_supplier', false]]);
    expect(a.totals.owedMinor).toBe(0);
    expect(a.debitNotes).toEqual([]);
    expect(a.shelfReturnDebitNotesTotal).toMatchObject({ valueMinor: 40_000, acceptedMinor: 0, notAcceptedMinor: 0 });
  });

  it('an accepted note is taken off what is owed once, at the accepted amount; the difference stays shown; another supplier\'s acceptance is ignored', () => {
    const a = fold([accepted('DN-1', 30_000, 25_000), { ...accepted('DN-2', 10_000, 10_000), supplierId: 'sup-other' }]);
    expect(a.shelfReturnDebitNotes.map((d) => [d.debitNoteRef, d.state, d.nettedInBalance])).toEqual([['DN-1', 'accepted', true], ['DN-2', 'waiting_for_supplier', false]]);
    expect(a.debitNotes.map((d) => [d.debitNoteRef, d.valueMinor, d.number])).toEqual([['DN-1', 25_000, 'SDN/26-27/00001']]);
    expect(a.debitNotes[0]!.reason).toBe('accepted by the supplier as credit note CN-1 of 2026-11-19');
    expect(a.totals.owedMinor).toBe(-25_000);
    expect(a.shelfReturnDebitNotesTotal).toMatchObject({ valueMinor: 10_000, acceptedMinor: 25_000, notAcceptedMinor: 5_000 });
    // The books: one debit-note posting at the accepted amount; once posted, nothing more.
    const [p] = planPayablesPostings([a], []);
    expect([p!.kind, p!.sourceId, p!.components['amount']]).toEqual(['supplier_debit_note', 'DN-1', 25_000]);
    expect(planPayablesPostings([a], [{ kind: 'supplier_debit_note', sourceKind: 'supplier_debit_note', sourceId: 'DN-1', supplierId: 'sup-1', components: p!.components }])).toEqual([]);
  });
});

describe('OB-879 — the screen\'s acceptance body', () => {
  it('needs the credit note\'s number and date; a blank amount is the whole note; rupees to paise exactly', () => {
    expect(acceptanceBody({ creditNoteNo: '', creditNoteDate: '2026-11-19' })).toEqual({ ok: false, why: 'needCreditNote' });
    expect(acceptanceBody({ creditNoteNo: 'CN-1', creditNoteDate: '' })).toEqual({ ok: false, why: 'needCreditNote' });
    expect(acceptanceBody({ creditNoteNo: 'CN-1', creditNoteDate: '2026-11-19', accepted: 'two fifty' })).toEqual({ ok: false, why: 'notRupees' });
    expect(acceptanceBody({ creditNoteNo: ' CN-1 ', creditNoteDate: '2026-11-19', accepted: '' })).toEqual({ ok: true, body: { supplierCreditNoteNo: 'CN-1', supplierCreditNoteDate: '2026-11-19' } });
    expect(acceptanceBody({ creditNoteNo: 'CN-1', creditNoteDate: '2026-11-19', accepted: '₹250.5', reason: ' part ' })).toEqual({ ok: true, body: { supplierCreditNoteNo: 'CN-1', supplierCreditNoteDate: '2026-11-19', acceptedMinor: 25_050, reason: 'part' } });
  });
});

describe('OB-881 B — the credit note\'s GST, typed on acceptance', () => {
  it('takes the goods and the GST off what is owed; the debit note carries the GST as its tax, so the posting reverses it once', () => {
    const a = fold([{ ...accepted('DN-1', 30_000, 30_000), gst: { cgstMinor: 750, sgstMinor: 750, igstMinor: 0, rateBps: 500 } }]);
    expect(a.debitNotes.map((d) => [d.valueMinor, d.taxableMinor, d.tax])).toEqual([[31_500, 30_000, { cgstMinor: 750, sgstMinor: 750, igstMinor: 0 }]]);
    expect(a.totals.owedMinor).toBe(-31_500);
    expect(a.shelfReturnDebitNotesTotal).toMatchObject({ acceptedMinor: 30_000, gstReversedMinor: 1_500 });
    const [p] = planPayablesPostings([a], []);
    expect(p!.components).toEqual({ amount: 31_500, taxable: 30_000, cgst: 750, sgst: 750, igst: 0 });
    // Without it: no tax on the note, exactly as before.
    expect(fold([accepted('DN-1', 30_000, 30_000)]).debitNotes[0]!.tax).toBeUndefined();
  });

  it('the screen sends each GST head typed (a minus reaches head office, to be refused in its words); blank is none', () => {
    const base = { creditNoteNo: 'CN-1', creditNoteDate: '2026-11-19' };
    expect(acceptanceBody({ ...base, cgst: '7.50', sgst: '7.5', igst: '' })).toEqual({ ok: true, body: { supplierCreditNoteNo: 'CN-1', supplierCreditNoteDate: '2026-11-19', cgstMinor: 750, sgstMinor: 750 } });
    expect(acceptanceBody({ ...base, igst: '−6.25' })).toEqual({ ok: true, body: { supplierCreditNoteNo: 'CN-1', supplierCreditNoteDate: '2026-11-19', igstMinor: -625 } });
    expect(acceptanceBody({ ...base, cgst: 'seven' })).toEqual({ ok: false, why: 'notRupees' });
  });
});
