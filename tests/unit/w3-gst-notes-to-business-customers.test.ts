import { describe, it, expect } from 'vitest';
import {
  customerNoteAgainstInvoice, financialYearOf, outwardNoteOf, gstr1Return, gstr1NotesSection, POSTING_KINDS_TO_MAP, DEFAULT_RETAIL_POSTING_MAP,
  type CustomerNote, type NoteInvoice,
} from '../../packages/finance/src/index';
import { limitedSubjectOf } from '../../packages/approvals/src/authority-rules';
import { APPROVAL_KINDS } from '../../services/identity/src/approval-requests';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { createNotesSession, noteBody, notesWords, B2B_NOTES_COPY } from '../../apps/web-erp/src/b2b-notes-session';

// M23-FR-02 · OB-678 (owner, 2 Nov 2026, in writing) — GST credit and debit notes to business customers: the pure engine
// (worked from the tax invoice head office holds), the GSTR-1 credit/debit-note section, the approval wiring (a refund under
// OB-290) and the office screen's tested session.

// Two lines, intra-State: rice 10 × ₹100 @ 5%, oil 2 × ₹150.50 @ 18% (odd paise so the cumulative split is exercised).
const INV: NoteInvoice = {
  documentId: 'inv1', number: 'INV-000007', customerId: 'CUST1', issuedOn: '2026-10-20', recipientGstin: '33ZZZZZ9999Z1ZF',
  lines: [
    { lineId: 'l1', productId: 'rice', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 },
    { lineId: 'l2', productId: 'oil', description: 'Oil 1L', qty: 2, unitPriceMinor: 15_050, taxRateBps: 1_800 },
  ],
  gst: {
    placeOfSupply: 'intra_state', deliveryStateCode: '33',
    lines: [
      { lineId: 'l1', taxableMinor: 100_000, rateBps: 500, cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0 },
      { lineId: 'l2', taxableMinor: 30_100, rateBps: 1_800, cgstMinor: 2_709, sgstMinor: 2_709, igstMinor: 0 },
    ],
  },
};
const note = (over: Partial<Parameters<typeof customerNoteAgainstInvoice>[0]> = {}) => customerNoteAgainstInvoice({
  noteId: 'N1', number: 'CN-000001', kind: 'credit_note', invoice: INV, customerId: 'CUST1', reason: 'goods_returned',
  lines: [{ lineId: 'l1', taxableMinor: 20_000 }], earlier: [], issuedOn: '2026-11-02', ...over,
});

describe('the note engine works from the invoice head office holds (M23-FR-02 · OB-678)', () => {
  it('reverses each line\'s CGST and SGST in the proportion they were charged, declared in the month it was issued', () => {
    const r = note({ lines: [{ lineId: 'l1', taxableMinor: 20_000 }, { lineId: 'l2', taxableMinor: 10_000 }] });
    expect(r.issued).toBe(true);
    expect(r.note).toMatchObject({
      taxableMinor: 30_000, cgstMinor: 500 + 900, sgstMinor: 500 + 900, igstMinor: 0, taxMinor: 2_800, grossMinor: 32_800,
      againstInvoiceNumber: 'INV-000007', invoiceDocumentId: 'inv1', declareInPeriod: '2026-11', financialYear: '2026-27', taxAdjustable: true,
      recipientGstin: '33ZZZZZ9999Z1ZF', placeOfSupplyStateCode: '33',
    });
    expect(r.note!.lines.map((l) => [l.lineId, l.cgstMinor, l.sgstMinor])).toEqual([['l1', 500, 500], ['l2', 900, 900]]);
  });

  it('never credits a line beyond what it charged less earlier credit notes, and the last note reverses exactly what is left', () => {
    const first = note({ lines: [{ lineId: 'l2', taxableMinor: 10_033 }] }).note as CustomerNote;
    const second = note({ noteId: 'N2', earlier: [first], lines: [{ lineId: 'l2', taxableMinor: 10_033 }] }).note as CustomerNote;
    const over = note({ noteId: 'N3', earlier: [first, second], lines: [{ lineId: 'l2', taxableMinor: 10_035 }] });
    expect(over).toMatchObject({ issued: false, outcome: 'exceeds_invoice' });
    expect(over.detail).toContain('at most 10034 is left');
    const last = note({ noteId: 'N3', earlier: [first, second], lines: [{ lineId: 'l2', taxableMinor: 10_034 }] }).note as CustomerNote;
    // Three notes together reverse EXACTLY what the line charged: ₹301.00 and ₹27.09 + ₹27.09 — not a paisa more.
    const all = [first, second, last].flatMap((n) => n.lines);
    expect(all.reduce((s, l) => s + l.taxableMinor, 0)).toBe(30_100);
    expect(all.reduce((s, l) => s + l.cgstMinor, 0)).toBe(2_709);
    expect(all.reduce((s, l) => s + l.sgstMinor, 0)).toBe(2_709);
    // A debit note does not use up the credit headroom.
    const debit = note({ noteId: 'D1', kind: 'debit_note', number: 'CDN-000001', lines: [{ lineId: 'l2', taxableMinor: 5_000 }] }).note as CustomerNote;
    expect(note({ noteId: 'N4', earlier: [debit], lines: [{ lineId: 'l2', taxableMinor: 30_100 }] }).issued).toBe(true);
  });

  it('a debit note charges the line\'s own rate, split as the invoice was — IGST across States', () => {
    const inter: NoteInvoice = { ...INV, gst: { ...INV.gst!, placeOfSupply: 'inter_state', deliveryStateCode: '32', lines: INV.gst!.lines.map((l) => ({ ...l, cgstMinor: 0, sgstMinor: 0, igstMinor: l.cgstMinor + l.sgstMinor })) } };
    const d = note({ kind: 'debit_note', number: 'CDN-000001', invoice: inter, reason: 'price_correction', lines: [{ lineId: 'l2', taxableMinor: 1_001 }] }).note!;
    expect(d).toMatchObject({ cgstMinor: 0, sgstMinor: 0, igstMinor: 180, grossMinor: 1_181, placeOfSupplyStateCode: '32' });
    expect(d.taxes).toEqual([{ component: 'IGST', rateBps: 1_800, amountMinor: 180 }]);
  });

  it('refuses by name: another customer, a line the invoice does not carry, a line twice, nothing, and an invoice with no GST split', () => {
    expect(note({ customerId: 'CUST2' }).outcome).toBe('wrong_customer');
    expect(note({ lines: [{ lineId: 'l9', taxableMinor: 100 }] }).outcome).toBe('line_not_on_invoice');
    expect(note({ lines: [{ lineId: 'l1', taxableMinor: 100 }, { lineId: 'l1', taxableMinor: 100 }] }).outcome).toBe('line_twice');
    expect(note({ lines: [] }).outcome).toBe('no_lines');
    expect(note({ lines: [{ lineId: 'l1', taxableMinor: 0 }] }).outcome).toBe('zero_value');
    const { gst: _gst, ...unsplit } = INV;
    const r = note({ invoice: unsplit });
    expect(r).toMatchObject({ issued: false, outcome: 'invoice_has_no_gst_split' });
    expect(r.detail).toMatch(/without guessing/);
  });

  it('after the CGST s.34(2) limit a note is commercial only; the financial year runs April to March', () => {
    expect(financialYearOf('2026-03-31')).toBe('2025-26');
    expect(financialYearOf('2026-04-01')).toBe('2026-27');
    const late = note({ issuedOn: '2027-12-01' });
    expect(late.note).toMatchObject({ taxAdjustable: false, declareInPeriod: '2027-12' });
  });
});

describe('the GSTR-1 data carries a credit/debit-note section (M23-FR-02 · OB-678)', () => {
  it('lists notes to registered buyers note by note, unregistered apart, out-of-window apart, with the period totals — and says the CA signs off how they are filed', () => {
    const cn = note().note!;
    const dn = note({ noteId: 'D1', number: 'CDN-000001', kind: 'debit_note', reason: 'price_correction', lines: [{ lineId: 'l1', taxableMinor: 1_000 }] }).note!;
    const { recipientGstin: _g, ...toUnregistered } = note({ noteId: 'N2', number: 'CN-000002' }).note!;
    const late = note({ noteId: 'N3', number: 'CN-000003', issuedOn: '2027-12-01' }).note!;
    const section = gstr1NotesSection([cn, dn, toUnregistered as CustomerNote, late].map(outwardNoteOf));
    expect(section.registered.map((r) => [r.noteNumber, r.noteType, r.recipientGstin, r.noteValueMinor, r.againstInvoiceNumber])).toEqual([
      ['CDN-000001', 'D', '33ZZZZZ9999Z1ZF', 1_050, 'INV-000007'], ['CN-000001', 'C', '33ZZZZZ9999Z1ZF', 21_000, 'INV-000007'],
    ]);
    expect(section.unregistered.map((r) => r.noteNumber)).toEqual(['CN-000002']);
    expect(section.outsideTaxWindow.map((r) => r.noteNumber)).toEqual(['CN-000003']);
    expect(section).toMatchObject({ creditTaxableMinor: 40_000, creditTaxMinor: 2_000, debitTaxableMinor: 1_000, debitTaxMinor: 50, inGstnFile: false });
    expect(section.caSignOff).toMatch(/C-01/);
    expect(section.registered[1]!.rateLines).toEqual([{ rateBps: 500, taxableMinor: 20_000, cgstMinor: 500, sgstMinor: 500, igstMinor: 0 }]);
    // The full return carries the section, and an empty one says so.
    expect(gstr1Return([], [outwardNoteOf(cn)]).creditDebitNotes.registered).toHaveLength(1);
    expect(gstr1Return([]).creditDebitNotes).toMatchObject({ registered: [], unregistered: [], detail: expect.stringMatching(/^no credit or debit note/) });
  });
});

describe('a credit note is a refund under the money limits; the posting rule is the accountant\'s (OB-678 · OB-290 · C-01)', () => {
  it('the approval kind is money-limited as a refund; the store manager and owner may approve; the accountant (no figure) may not', () => {
    expect(limitedSubjectOf('customer_credit_note')).toBe('refund');
    expect(APPROVAL_KINDS['customer_credit_note']).toMatchObject({ makerPermission: 'finance.creditnote.issue', checkerPermission: 'finance.creditnote.approve' });
    const holds = (role: string) => ROLE_CATALOGUE.find((r) => r.id === role)!.permissions.includes('finance.creditnote.approve');
    expect([holds('owner'), holds('store_manager'), holds('accountant'), holds('cashier')]).toEqual([true, true, false, false]);
  });

  it('the posting map lists both note kinds for the accountant WITHOUT a suggested account — never invented', () => {
    const kinds = POSTING_KINDS_TO_MAP.filter((k) => k.kind.startsWith('b2b:') && k.kind.endsWith('_note'));
    expect(kinds.map((k) => [k.kind, k.components])).toEqual([['b2b:credit_note', ['total', 'net', 'tax']], ['b2b:debit_note', ['total', 'net', 'tax']]]);
    expect(kinds.every((k) => (k.legs ?? []).every((l) => !('account' in l)))).toBe(true);
    expect(DEFAULT_RETAIL_POSTING_MAP.rules.some((r) => r.kind === 'b2b:credit_note' || r.kind === 'b2b:debit_note')).toBe(false);
  });
});

describe('the office screen\'s notes session (Business customers page)', () => {
  const viewer = { userId: 'u-acct', permissions: ['finance.creditnote.issue'] };
  it('sends no invoice figures — only the invoice id and each line\'s value in paise; refuses a blank or unreadable line before calling', async () => {
    expect(noteBody({ kind: 'credit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: 'goods_returned', rupeesByLine: { l1: '200', l2: '' } }, 'N-1'))
      .toEqual({ body: { noteId: 'N-1', kind: 'credit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: 'goods_returned', lines: [{ lineId: 'l1', taxableMinor: 20_000 }] } });
    expect(noteBody({ kind: 'credit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: 'goods_returned', rupeesByLine: { l1: '' } }, 'N')).toEqual({ why: 'needLines' });
    expect(noteBody({ kind: 'credit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: '', rupeesByLine: { l1: '5' } }, 'N')).toEqual({ why: 'needReason' });
    const calls: string[] = [];
    const s = createNotesSession({ viewer, fetch: (async (u: string) => { calls.push(u); return new Response('{}'); }) as unknown as typeof fetch });
    expect(await s.raise({ kind: 'credit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: 'goods_returned', rupeesByLine: { l1: 'abc' } })).toEqual({ result: 'invalid', why: 'needLines' });
    expect(calls).toEqual([]);
    expect(createNotesSession({ viewer: { userId: 'u-cash', permissions: [] } }).may).toEqual({ named: true, issue: false });
  });

  it('a credit note is previewed and its approval asked with exactly head office\'s figures; a debit note is issued at once', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const answer: Record<string, unknown> = {
      '/v1/finance/credit-notes/preview': { approval: { kind: 'customer_credit_note', subjectRef: 'credit-note:CUST1/N-1', valueMinor: 21_000, details: { noteId: 'N-1' }, summary: 'Credit note ₹210.00' } },
      '/v1/approvals/requests': { requestId: 'req-1' },
      '/v1/finance/credit-notes': { number: 'CDN-000001' },
    };
    const fake = (async (url: string, init: { body?: string }) => { calls.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body) }); return new Response(JSON.stringify(answer[url] ?? {}), { status: 200 }); }) as unknown as typeof fetch;
    const s = createNotesSession({ viewer, fetch: fake, newNoteId: () => 'N-1' });
    expect(await s.raise({ kind: 'credit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: 'goods_returned', rupeesByLine: { l1: '200' } })).toEqual({ result: 'ok', value: { asked: 'req-1' } });
    expect(calls.map((c) => c.url)).toEqual(['/v1/finance/credit-notes/preview', '/v1/approvals/requests']);
    expect(calls[1]!.body).toMatchObject({ kind: 'customer_credit_note', subjectRef: 'credit-note:CUST1/N-1', valueMinor: 21_000, details: { noteId: 'N-1' } });
    expect(await s.issueApproved({ requestId: 'req-1', kind: 'customer_credit_note', subjectRef: 'x', status: 'approved', valueMinor: 21_000, summary: 's', details: { noteId: 'N-1' } }))
      .toMatchObject({ result: 'ok' });
    expect(calls[2]).toEqual({ url: '/v1/finance/credit-notes', body: { noteId: 'N-1', approvalId: 'req-1' } });
    calls.length = 0;
    expect(await s.raise({ kind: 'debit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: 'price_correction', rupeesByLine: { l1: '10' } })).toEqual({ result: 'ok', value: { number: 'CDN-000001' } });
    expect(calls.map((c) => c.url)).toEqual(['/v1/finance/credit-notes']);
  });

  it('every word has a Tamil twin', () => {
    expect(Object.keys(B2B_NOTES_COPY.ta).sort()).toEqual(Object.keys(B2B_NOTES_COPY.en).sort());
    expect(notesWords('ta', 'posting_waiting_for_posting_rule')).toMatch(/கணக்காளர/);
  });
});
