import { describe, it, expect } from 'vitest';
import {
  createBillCheckSession, createPayablesBooksSession, createApTallySession, SUPPLIER_BOOKS_COPY, supplierBooksWords, type AskedCheck,
} from '../../apps/web-erp/src/supplier-bills-to-the-books-session';
import { typedCaptureBody } from '../../apps/web-erp/src/supplier-bills-session';

// WF-05 (W4) — the after-match steps' office sessions: the bill's second check, debit notes, supplier bills in the books,
// the month's supplier-bill Tally file. Each sends only head office's own routes, refuses on the screen what it can, and
// never sends a figure head office works out itself (nothing is typed into the books).

const recorder = (answer: unknown = {}) => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};
const BUYER = { userId: 'u-buyer', permissions: ['purchase.invoice.capture'] };
const CHECKER = { userId: 'u-acct', permissions: ['purchase.invoice.match', 'finance.period.read', 'finance.journal.post'] };

describe('the second person\'s check of a typed bill (WF-05 · §28)', () => {
  const typed = typedCaptureBody({ invoiceId: 'sup-k-7', supplierId: 'sup-k', poId: 'po-1', total: '500', lines: [{ productId: 'RICE', quantity: '10', unitPrice: '50', amount: '500' }], documentId: 'bill-9' });
  if (!typed.ok) throw new Error('typed');

  it('asks for exactly the bill as it will be saved, then saves it naming the approval — the same bill, nothing re-typed', async () => {
    const r = recorder({ requestId: 'req-1' });
    const s = createBillCheckSession({ viewer: BUYER, fetch: r.fetch });
    expect((await s.askCheck({ invoiceId: typed.invoiceId, body: typed.body })).result).toBe('ok');
    expect(r.calls[0]).toEqual({
      method: 'POST', url: '/v1/approvals/requests',
      body: { kind: 'supplier_invoice_check', subjectRef: 'sup-k-7', valueMinor: 50_000, details: { ...typed.body, invoiceId: 'sup-k-7' }, summary: 'Supplier bill sup-k-7 from sup-k: ₹500.00', reason: 'Check the typed bill against the paper' },
    });
    const approved: AskedCheck = { requestId: 'req-1', kind: 'supplier_invoice_check', subjectRef: 'sup-k-7', status: 'approved', valueMinor: 50_000, summary: '', details: { ...typed.body, invoiceId: 'sup-k-7' }, decidedBy: 'u-acct' };
    await s.saveChecked(approved);
    expect(r.calls[1]).toEqual({ method: 'POST', url: '/v1/purchase/invoices/sup-k-7/capture', body: { ...typed.body, approvalId: 'req-1' } });
  });

  it('lists only bill checks among the person\'s own requests', async () => {
    const r = recorder({ mine: [{ requestId: 'a', kind: 'supplier_invoice_check' }, { requestId: 'b', kind: 'supplier_payment' }] });
    const out = await createBillCheckSession({ viewer: BUYER, fetch: r.fetch }).asked();
    expect(out).toMatchObject({ result: 'ok', value: [{ requestId: 'a' }] });
    expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/approvals/requests']);
  });

  it('refuses on the screen: nobody signed in, no capture right, no bill typed — nothing is sent', async () => {
    const r = recorder();
    expect(await createBillCheckSession({ viewer: undefined, fetch: r.fetch }).askCheck({ invoiceId: 'x', body: { declaredTotalMinor: 1 } })).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createBillCheckSession({ viewer: CHECKER, fetch: r.fetch }).askCheck({ invoiceId: 'x', body: { declaredTotalMinor: 1 } })).toEqual({ result: 'invalid', why: 'cannotCapture' });
    expect(await createBillCheckSession({ viewer: BUYER, fetch: r.fetch }).askCheck({ invoiceId: '', body: {} })).toEqual({ result: 'invalid', why: 'needBill' });
    expect(r.calls).toEqual([]);
  });
});

describe('debit notes for goods sent back (WF-05)', () => {
  it('reads the supplier\'s account and issues a note by its reference — no value is sent', async () => {
    const r = recorder({ number: 'DN-000001', alreadyIssued: false });
    const s = createBillCheckSession({ viewer: CHECKER, fetch: r.fetch });
    await s.account(' sup-k ');
    await s.issueDebitNote('sup-k', 'DN-grn-1-L3');
    expect(r.calls).toEqual([
      { method: 'GET', url: '/v1/purchase/suppliers/sup-k/account' },
      { method: 'POST', url: '/v1/purchase/suppliers/sup-k/debit-notes/DN-grn-1-L3/issue', body: {} },
    ]);
    expect(await createBillCheckSession({ viewer: BUYER, fetch: r.fetch }).issueDebitNote('sup-k', 'x')).toEqual({ result: 'invalid', why: 'cannotMatch' });
    expect(await s.account('')).toEqual({ result: 'invalid', why: 'needSupplier' });
  });
});

describe('supplier bills in the books, and for Tally (WF-05 · M23-FR-01/04)', () => {
  it('posts with nothing sent and reads the books; a reader without the posting right posts nothing', async () => {
    const r = recorder();
    const s = createPayablesBooksSession({ viewer: CHECKER, fetch: r.fetch });
    await s.post(); await s.read();
    expect(r.calls).toEqual([{ method: 'POST', url: '/v1/finance/payables/post', body: {} }, { method: 'GET', url: '/v1/finance/payables' }]);
    const reader = createPayablesBooksSession({ viewer: { userId: 'u-mgr', permissions: ['finance.period.read'] }, fetch: r.fetch });
    expect(reader.may).toEqual({ read: true, post: false });
    expect(await reader.post()).toEqual({ result: 'invalid', why: 'cannotPost' });
    expect(r.calls).toHaveLength(2);
  });

  it('asks for the month\'s supplier-bill file by the month alone', async () => {
    const r = recorder();
    const s = createApTallySession({ viewer: CHECKER, fetch: r.fetch });
    expect(await s.vouchers('2026-13')).toEqual({ result: 'invalid', why: 'needPeriod' });
    await s.vouchers('2026-11');
    expect(r.calls).toEqual([{ method: 'GET', url: '/v1/finance/tally/ap-vouchers?period=2026-11' }]);
  });

  it('speaks English and Tamil for every word', () => {
    for (const k of Object.keys(SUPPLIER_BOOKS_COPY.en)) {
      expect((SUPPLIER_BOOKS_COPY.ta as Record<string, string>)[k], k).toBeTruthy();
      if (k !== 'gstL') expect(supplierBooksWords('ta', k), k).not.toBe(supplierBooksWords('en', k));
    }
  });
});
