import { describe, it, expect } from 'vitest';
import {
  createSupplierBillsSession, readPickedFile, confirmBody, typedCaptureBody, presentMatch, rupeesToPaise, quantityToSteps, documentIdFor,
  type BillDocument, type HeadOfficeCall,
} from '../../apps/web-erp/src/supplier-bills-session';
import { createOpenToBuySession, presentOpenToBuy, budgetHistory, waitingOrders, budgetEntry } from '../../apps/web-erp/src/open-to-buy-session';

/**
 * The two round-12 screen models (D03-FR-02 · WF-05 supplier bills; WF-03 · D02-FR-01 · OB-63 open-to-buy) — DOM-free. They
 * hold no business rule: they turn what a person typed into the routes' bodies (money exactly from the decimal text), hand
 * head office's refusals back in its own words, and order what they show by exception. The connected proof is in
 * tests/e2e/supplier-bills-on-the-production-api.e2e.ts and tests/e2e/open-to-buy-on-the-production-api.e2e.ts.
 */

const recorder = (answers: Record<string, { status: number; body: unknown } | 'unreachable'>) => {
  const calls: { method: string; path: string; body?: unknown; idempotencyKey?: string }[] = [];
  const call: HeadOfficeCall = async (req) => {
    calls.push(req);
    const hit = Object.entries(answers).find(([k]) => `${req.method} ${req.path}`.startsWith(k));
    return hit === undefined ? { status: 404, body: {} } : hit[1];
  };
  return { call, calls };
};

const draft = (over: Partial<BillDocument> = {}): BillDocument => ({
  documentId: 'bill-1', channel: 'e_invoice', state: 'draft', receivedBy: 'u-b', receivedAt: '2026-10-12T00:00:00Z', supplierId: 'sup-k', poId: 'po-1',
  extracted: { supplierGstin: '33X', supplierInvoiceNo: 'KA/101', invoiceDate: '2026-10-05', irn: null, statedTotalMinor: 94_500, engine: 'gst-e-invoice-json' },
  lines: [
    { lineNo: 1, supplierItemCode: 'K-RICE', description: 'rice', hsn: '1006', quantity: 10, uom: 'ea', unitPriceMinor: 5_000, lineTotalMinor: 50_000, cgstMinor: 1_250, sgstMinor: 1_250, igstMinor: 0, confidence: 1, suggestedProductId: 'RICE', needsFigures: false },
    { lineNo: 2, supplierItemCode: 'K-SUGAR', description: 'sugar', hsn: '1701', quantity: null, uom: 'kg', unitPriceMinor: null, lineTotalMinor: null, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, confidence: 0.6, suggestedProductId: null, needsFigures: true },
  ],
  problems: [], ...over,
});

describe('supplier bills — the screen model (D03-FR-02 · WF-05)', () => {
  it('money and quantities are read exactly from the text a person typed, never through floating point', () => {
    expect([rupeesToPaise('50'), rupeesToPaise('12.5'), rupeesToPaise('1,234.05'), rupeesToPaise('0.1'), rupeesToPaise('1.005'), rupeesToPaise('-3'), rupeesToPaise('abc')])
      .toEqual([5_000, 1_250, 123_405, 10, undefined, undefined, undefined]);
    expect([quantityToSteps('2.5', 'kg'), quantityToSteps('4', 'ea'), quantityToSteps('4.0', null), quantityToSteps('4.5', 'ea'), quantityToSteps('x', 'kg')]).toEqual([2_500, 4, 4, undefined, undefined]);
  });

  it('a picked file becomes the route body: .json → e-invoice, an image or PDF → scan, anything else is not a bill; the id is the file\'s fingerprint', () => {
    const json = readPickedFile({ name: 'KA.json', mediaType: 'application/json', contentBase64: '', text: '{"DocDtls":{"No":"1"}}', sha256: 'ab'.repeat(32) }, { poId: ' po-1 ', supplierId: '' });
    expect(json).toEqual({ ok: true, documentId: documentIdFor('ab'.repeat(32)), body: { kind: 'e_invoice', eInvoice: { DocDtls: { No: '1' } }, poId: 'po-1' } });
    expect(readPickedFile({ name: 'p.png', mediaType: 'image/png', contentBase64: 'AAAA', sha256: 'cd'.repeat(32) })).toMatchObject({ ok: true, body: { kind: 'scan', mediaType: 'image/png', contentBase64: 'AAAA' } });
    expect(readPickedFile({ name: 'x.json', mediaType: '', contentBase64: '', text: '{oops', sha256: '00' })).toEqual({ ok: false, problem: 'not_json' });
    expect(readPickedFile({ name: 'x.txt', mediaType: 'text/plain', contentBase64: '', sha256: '00' })).toEqual({ ok: false, problem: 'not_a_bill_file' });
  });

  it('confirming sends every mapped line, typed figures exactly — and leaves an unmapped or untyped line for head office to refuse', () => {
    const body = confirmBody(draft(), { invoiceId: ' inv-1 ', entries: [{ lineNo: 1, productId: 'RICE' }, { lineNo: 2, productId: 'SUGAR', quantity: '2.5', unitPrice: '44', amount: '110' }] });
    expect(body).toEqual({ invoiceId: 'inv-1', lines: [{ lineNo: 1, productId: 'RICE' }, { lineNo: 2, productId: 'SUGAR', quantity: 2_500, unitPriceMinor: 4_400, lineTotalMinor: 11_000 }] });
    // Not filled in here — head office refuses (`lines_need_a_person`) and nothing is recorded.
    expect(confirmBody(draft(), { invoiceId: 'inv-1', entries: [{ lineNo: 1, productId: '' }, { lineNo: 2, productId: 'SUGAR', quantity: '2.5', unitPrice: 'x', amount: '110' }] }))
      .toEqual({ invoiceId: 'inv-1', lines: [{ lineNo: 2, productId: 'SUGAR' }] });
  });

  it('a typed bill is the paper as typed; only its shape is checked here', () => {
    expect(typedCaptureBody({ invoiceId: 'i', supplierId: 's', total: '500', lines: [{ productId: 'RICE', quantity: '10', unitPrice: '50', amount: '500', cgst: '12.5' }] }))
      .toEqual({ ok: true, invoiceId: 'i', body: { supplierId: 's', declaredTotalMinor: 50_000, lines: [{ productId: 'RICE', quantity: 10, unitPriceMinor: 5_000, lineTotalMinor: 50_000, cgstMinor: 1_250 }] } });
    expect(typedCaptureBody({ invoiceId: '', supplierId: 's', total: '1', lines: [] })).toEqual({ ok: false, problem: 'needs_invoice_supplier_total' });
    expect(typedCaptureBody({ invoiceId: 'i', supplierId: 's', total: '1', lines: [{ productId: 'R', quantity: '1.5', unitPrice: '1', amount: '1' }] })).toEqual({ ok: false, problem: 'not_money', line: 1 });
    // Lines that do not add up to the total are NOT refused here — that is head office's judgement.
    expect(typedCaptureBody({ invoiceId: 'i', supplierId: 's', total: '999', lines: [{ productId: 'R', quantity: '1', unitPrice: '1', amount: '1' }] })).toMatchObject({ ok: true });
    // The scan it was typed from rides along, so head office links it (round 12 follow-up) — nothing kept in the tab.
    expect(typedCaptureBody({ invoiceId: 'i', supplierId: 's', total: '1', lines: [{ productId: 'R', quantity: '1', unitPrice: '1', amount: '1' }], documentId: ' bill-abc ' }))
      .toMatchObject({ ok: true, body: { documentId: 'bill-abc' } });
    expect(typedCaptureBody({ invoiceId: 'i', supplierId: 's', total: '1', lines: [{ productId: 'R', quantity: '1', unitPrice: '1', amount: '1' }], documentId: '' }))
      .not.toMatchObject({ body: { documentId: expect.anything() } });
  });

  it('the match is shown exceptions first, with head office\'s own sentence and flags', () => {
    const m = presentMatch({ invoiceId: 'i', poId: 'po-1', blocked: true, payableMinor: 1, invoicedMinor: 2, withheldMinor: 1, ownerAction: 'Hold it', matchedBy: 'u', matchedAt: 't', flags: ['no_approval'],
      lines: [{ productId: 'A', status: 'matched', payableMinor: 1, detail: 'ok' }, { productId: 'B', status: 'blocked', payableMinor: 0, detail: 'short' }, { productId: 'C', status: 'within_tolerance', payableMinor: 0, detail: 'near' }] });
    expect(m?.lines.map((l) => l.productId)).toEqual(['B', 'C', 'A']);
    expect(m).toMatchObject({ blocked: true, ownerAction: 'Hold it', flags: ['no_approval'] });
    expect(presentMatch(null)).toBeNull();
  });

  it('every refusal comes back in head office\'s words; a dropped link is said; permissions only shape what is offered', async () => {
    const { call, calls } = recorder({
      'POST /v1/purchase/invoice-documents/bill-1/confirm': { status: 422, body: { error: { code: 'lines_need_a_person', whatHappened: 'Line(s) 2 are not mapped to a product.', nextSafeAction: 'Map every line' } } },
      'GET /v1/purchase/invoice-documents': 'unreachable',
    });
    const s = createSupplierBillsSession(call, { permissions: ['purchase.invoice.capture'] });
    expect([s.mayCapture, s.mayMatch]).toEqual([true, false]);
    expect(await s.confirm(draft(), { invoiceId: 'i', entries: [] })).toEqual({ ok: false, unreachable: false, status: 422, code: 'lines_need_a_person', whatHappened: 'Line(s) 2 are not mapped to a product.', nextSafeAction: 'Map every line' });
    expect(await s.register()).toEqual({ ok: false, unreachable: true });
    // Two hand-ins of one file: one document id, each click its own key (so "already received" is head office's answer).
    const file = { name: 'a.png', mediaType: 'image/png', contentBase64: 'AA', sha256: 'ef'.repeat(32) };
    await s.handIn(file); await s.handIn(file);
    const ins = calls.filter((c) => c.method === 'POST' && !c.path.endsWith('/confirm'));
    expect(new Set(ins.map((c) => c.path)).size).toBe(1);
    expect(ins[0]?.idempotencyKey).not.toBe(ins[1]?.idempotencyKey);
    // The confirmation key is the body's: a re-click of the same confirmation collapses, a changed one is new.
    await s.confirm(draft(), { invoiceId: 'i', entries: [] });
    const confirms = calls.filter((c) => c.path.endsWith('/confirm'));
    expect(confirms[0]?.idempotencyKey).toBe(confirms[1]?.idempotencyKey);
    await s.confirm(draft(), { invoiceId: 'j', entries: [] });
    expect(calls.filter((c) => c.path.endsWith('/confirm'))[2]?.idempotencyKey).not.toBe(confirms[0]?.idempotencyKey);
  });
});

describe('open to buy — the screen model (WF-03 · D02-FR-01 · OB-63)', () => {
  it('categories over budget first; every figure ever set, newest first, the replaced ones marked; waiting orders with their escalation', () => {
    const v = presentOpenToBuy({ period: '2026-10', storeId: null, asAt: 't', overrides: [{ poId: 'po-2', approvedBy: 'u-owner', reason: 'Diwali', overByMinor: 10_000, at: 't', check: {} }],
      categories: [
        { categoryId: 'grocery', budgetMinor: 100_000, budgetScope: 'company', committedMinor: 60_000, waitingMinor: 0, openToBuyMinor: 40_000, openAfterWaitingMinor: 40_000, state: 'within' },
        { categoryId: 'home', budgetMinor: 10_000, budgetScope: 'store', committedMinor: 20_000, waitingMinor: 0, openToBuyMinor: -10_000, openAfterWaitingMinor: -10_000, state: 'over' },
        { categoryId: 'uncategorised', budgetMinor: null, budgetScope: null, committedMinor: 700, waitingMinor: 0, openToBuyMinor: null, openAfterWaitingMinor: null, state: 'no_budget' },
      ] });
    expect(v?.rows.map((r) => r.categoryId)).toEqual(['home', 'grocery', 'uncategorised']);
    expect(v?.overrides).toEqual([{ poId: 'po-2', approvedBy: 'u-owner', reason: 'Diwali', overByMinor: 10_000, at: 't' }]);
    const h = budgetHistory({ budgets: [
      { categoryId: 'grocery', period: '2026-10', storeId: null, amountMinor: 100_000, reason: 'plan', setBy: 'u-owner', setAt: '1' },
      { categoryId: 'grocery', period: '2026-09', storeId: null, amountMinor: 5, reason: 'old month', setBy: 'u-owner', setAt: '0' },
      { categoryId: 'grocery', period: '2026-10', storeId: null, amountMinor: 150_000, reason: 'uplift', setBy: 'u-owner', setAt: '2' },
    ] }, '2026-10');
    expect(h.map((x) => [x.amountMinor, x.superseded])).toEqual([[150_000, false], [100_000, true]]);
    const w = waitingOrders({ orders: [
      { poId: 'po-a', status: 'proposed', at: '2026-10-03T00:00:00Z', supplierId: 's', requisitionedBy: 'u-b', totalMinor: 1, deliverTo: 'br-1', budgetCheck: { overBudget: false, overByMinor: 0, categories: [] } },
      { poId: 'po-b', status: 'proposed', at: '2026-10-04T00:00:00Z', supplierId: 's', requisitionedBy: 'u-b', totalMinor: 9, deliverTo: 'br-1', budgetCheck: { overBudget: true, overByMinor: 500, categories: [{ categoryId: 'grocery', state: 'over', budgetMinor: 1, committedMinor: 2, thisOrderMinor: 9 }] } },
      { poId: 'po-c', status: 'issued', at: '2026-10-04T00:00:00Z', supplierId: 's', requisitionedBy: 'u-b', totalMinor: 9 },
      { poId: 'po-d', status: 'proposed', at: '2026-09-30T00:00:00Z', supplierId: 's', requisitionedBy: 'u-b', totalMinor: 9 },
    ] }, '2026-10');
    expect(w.map((o) => [o.poId, o.escalation?.overByMinor ?? null])).toEqual([['po-b', 500], ['po-a', null]]);
    expect(w[0]?.escalation?.overCategories).toEqual([{ categoryId: 'grocery', budgetMinor: 1, committedMinor: 2, thisOrderMinor: 9 }]);
  });

  it('a budget entry is checked only for its shape; the amount exactly in paise', () => {
    expect(budgetEntry({ categoryId: ' grocery ', period: '2026-10', amount: '1,000.50', reason: ' plan ', storeId: '' })).toEqual({ ok: true, body: { categoryId: 'grocery', period: '2026-10', amountMinor: 100_050, reason: 'plan' } });
    expect(budgetEntry({ categoryId: 'g', period: '2026-10', amount: '', reason: 'x' })).toEqual({ ok: false, problem: 'fill_category_amount_reason' });
    expect(budgetEntry({ categoryId: 'g', period: '2026-10', amount: 'ten', reason: 'x' })).toEqual({ ok: false, problem: 'not_money' });
  });

  it('the over-budget escalation is head office\'s refusal, in its words; the over-budget reason rides only when given', async () => {
    const { call, calls } = recorder({
      'POST /v1/purchase/orders/po-2/approval': { status: 422, body: { error: { code: 'over_budget_reason_required', whatHappened: 'Purchase order po-2 is over budget', nextSafeAction: 'Send overBudgetReason' } } },
    });
    const s = createOpenToBuySession(call, { permissions: ['purchase.commitment.read', 'purchase.order.approve'] });
    expect([s.mayRead, s.maySetBudget, s.mayIssue]).toEqual([true, false, true]);
    expect(await s.issue('po-2', 'weekly')).toMatchObject({ ok: false, code: 'over_budget_reason_required', whatHappened: 'Purchase order po-2 is over budget' });
    await s.issue('po-2', 'weekly', 'Diwali');
    expect(calls.map((c) => c.body)).toEqual([{ reason: 'weekly' }, { reason: 'weekly', overBudgetReason: 'Diwali' }]);
    // A different body is a different key — never the 409 "key reused" for a corrected retry.
    expect(calls[0]?.idempotencyKey).not.toBe(calls[1]?.idempotencyKey);
  });
});
