import { describe, it, expect } from 'vitest';
import { creditNoteRoutes, CUSTOMER_NOTE_SERIES, type CreditNoteDeps } from '../../services/finance/src/credit-notes';
import type { CustomerNote } from '../../packages/finance/src/index';
import type { StoredB2BDocument } from '../../services/finance/src/b2b-documents';
import type { RequestContext, Route } from '../../services/kernel/src/index';

// M23-FR-02 · OB-678 (owner, 2 Nov 2026, in writing) — the running route for GST notes to business customers. Before W3 it
// took the "original invoice" from the request body and head office never looked it up. Now it LOOKS UP the business tax
// invoice head office holds and works every figure from it; a body that still carries an invoice is refused by name; a
// credit note is issued only on a second person's approval (a refund under OB-290); each kind draws its own number series,
// and a refused note draws none. The tax arithmetic is pinned in tests/unit/w3-gst-notes-to-business-customers.test.ts; the
// whole path with the real approvals engine in tests/integration/w3-gst-notes-to-business-customers.test.ts.

const NOW = '2026-11-02T06:00:00.000Z'; // 11:30 in the shop

const INVOICE: StoredB2BDocument = {
  documentId: 'inv1', number: 'INV-000001', kind: 'tax_invoice', customerId: 'CUST1', tenantId: 'sre', issuedAt: '2026-10-20T05:00:00.000Z',
  lines: [{ lineId: 'l1', productId: 'rice', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 }],
  netMinor: 100_000, taxMinor: 5_000, grossMinor: 105_000, taxClaimable: true, detail: 'x',
  gst: { placeOfSupply: 'intra_state', supplierStateCode: '33', deliveryStateCode: '33', basis: 'store_state_assumed', cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0, lines: [{ lineId: 'l1', taxableMinor: 100_000, rateBps: 500, cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0 }] },
};

const ctx = (body: unknown, userId = 'u-acct'): RequestContext => ({
  tenantId: 'sre', userId, branchId: null, params: {}, query: {}, body, traceId: 't',
});

function routes(over: Partial<CreditNoteDeps> = {}): { issue: Route; preview: Route; saved: CustomerNote[]; drawn: string[] } {
  const saved: CustomerNote[] = [];
  const drawn: string[] = [];
  const deps: CreditNoteDeps = {
    notes: () => saved,
    businessInvoice: (_t, customerId, documentId) => (customerId === 'CUST1' && documentId === 'inv1' ? INVOICE : undefined),
    recordCustomerNote: (_t, n) => { saved.push(n); },
    allocateNumber: (_t, series) => { drawn.push(series); return drawn.filter((s) => s === series).length; },
    now: () => NOW,
    ...over,
  };
  const all = creditNoteRoutes(deps);
  const issue = all.find((r) => r.method === 'POST' && r.path === '/v1/finance/credit-notes');
  const preview = all.find((r) => r.method === 'POST' && r.path === '/v1/finance/credit-notes/preview');
  if (issue === undefined || preview === undefined) throw new Error('note routes missing');
  return { issue, preview, saved, drawn };
}

const asked = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  noteId: 'N-1', kind: 'credit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: 'goods_returned',
  lines: [{ lineId: 'l1', taxableMinor: 20_000 }], ...over,
});

describe('POST /v1/finance/credit-notes works from the business tax invoice head office holds (M23-FR-02 · OB-678)', () => {
  it('refuses a request that carries the invoice itself — by name, nothing issued, no number drawn', async () => {
    const { issue, preview, saved, drawn } = routes();
    const withInvoice = asked({ invoice: { invoiceId: 'inv1', taxableMinor: 999_999_00 } });
    await expect(issue.handler(ctx(withInvoice))).rejects.toMatchObject({ status: 422, body: { code: 'invoice_is_looked_up' } });
    await expect(preview.handler(ctx(withInvoice))).rejects.toMatchObject({ status: 422, body: { code: 'invoice_is_looked_up' } });
    expect(saved).toEqual([]); expect(drawn).toEqual([]);
  });

  it('refuses an invoice head office does not hold (a till bill, another customer\'s) — a till return is refunded at the till', async () => {
    const { issue } = routes();
    await expect(issue.handler(ctx(asked({ invoiceDocumentId: 'RCP-000123' })))).rejects.toMatchObject({ status: 404, body: { code: 'not_a_business_tax_invoice' } });
    await expect(issue.handler(ctx(asked({ customerId: 'CUST2' })))).rejects.toMatchObject({ status: 404, body: { code: 'not_a_business_tax_invoice' } });
  });

  it('works the tax from the invoice in a preview, and asks approval for exactly the whole value — writing nothing', async () => {
    const { preview, saved, drawn } = routes();
    const res = await preview.handler(ctx(asked()));
    const body = res.body as { note: CustomerNote; needsApproval: boolean; approval: { kind: string; subjectRef: string; valueMinor: number; details: Record<string, unknown> } };
    expect(body.note).toMatchObject({ taxableMinor: 20_000, cgstMinor: 500, sgstMinor: 500, igstMinor: 0, grossMinor: 21_000, againstInvoiceNumber: 'INV-000001', declareInPeriod: '2026-11' });
    expect(body.needsApproval).toBe(true);
    expect(body.approval).toEqual({ kind: 'customer_credit_note', subjectRef: 'credit-note:CUST1/N-1', valueMinor: 21_000, details: asked(), summary: expect.stringContaining('₹210.00') });
    expect(saved).toEqual([]); expect(drawn).toEqual([]);
  });

  it('a credit note without an approval is refused by name and draws no number; with no engine wired no approval is ever found', async () => {
    const { issue, saved, drawn } = routes();
    await expect(issue.handler(ctx(asked()))).rejects.toMatchObject({ status: 422, body: { code: 'credit_note_needs_approval' } });
    await expect(issue.handler(ctx(asked({ approvalId: 'made-up' })))).rejects.toMatchObject({ status: 422, body: { code: 'approval_unknown' } });
    expect(saved).toEqual([]); expect(drawn).toEqual([]);
  });

  it('a debit note needs no approval (OB-678 sets none) and draws from its OWN series, apart from credit notes and supplier DN', async () => {
    const { issue, saved, drawn } = routes();
    const res = await issue.handler(ctx(asked({ noteId: 'D-1', kind: 'debit_note', reason: 'price_correction', lines: [{ lineId: 'l1', taxableMinor: 1_000 }] })));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: 'CDN-000001', noApprovalWhy: expect.stringContaining('OB-678'), invoiceUnchanged: true, posting: { state: 'waiting_for_posting_rule' } });
    expect(drawn).toEqual([CUSTOMER_NOTE_SERIES.debit_note]);
    expect(CUSTOMER_NOTE_SERIES).toEqual({ credit_note: 'customer_credit_note', debit_note: 'customer_debit_note' });
    expect(Object.values(CUSTOMER_NOTE_SERIES)).not.toContain('debit_note'); // the supplier debit note's series (DN)
    expect(saved[0]).toMatchObject({ kind: 'debit_note', taxableMinor: 1_000, cgstMinor: 25, sgstMinor: 25, grossMinor: 1_050, issuedBy: 'u-acct' });
    // The same note sent again is the same note — never a second debit, never a second number.
    const again = await issue.handler(ctx(asked({ noteId: 'D-1', kind: 'debit_note', reason: 'price_correction', lines: [{ lineId: 'l1', taxableMinor: 1_000 }] })));
    expect(again).toMatchObject({ status: 200, body: { alreadyIssued: true } });
    expect(drawn).toHaveLength(1); expect(saved).toHaveLength(1);
    // A different note under the same id is refused.
    await expect(issue.handler(ctx(asked({ noteId: 'D-1', kind: 'credit_note' })))).rejects.toMatchObject({ status: 409, body: { code: 'note_id_in_use' } });
  });

  it('refuses a malformed note (400) and a note with no reason (422) before anything else', async () => {
    const { issue } = routes();
    await expect(issue.handler(ctx(asked({ lines: [{ lineId: 'l1', taxableMinor: 'lots' }] })))).rejects.toMatchObject({ status: 400, body: { code: 'not_readable_as_a_note' } });
    await expect(issue.handler(ctx(asked({ kind: 'refund' })))).rejects.toMatchObject({ status: 400 });
    await expect(issue.handler(ctx(asked({ reason: undefined })))).rejects.toMatchObject({ status: 422, body: { code: 'no_reason' } });
  });
});
