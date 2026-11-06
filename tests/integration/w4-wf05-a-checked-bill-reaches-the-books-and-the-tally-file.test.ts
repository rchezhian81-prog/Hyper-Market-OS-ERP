import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { P3, p3Shop, caller, issuedOrder } from '../support/p3-purchase';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { validateTallyImport } from '../../packages/tally-export/src/index';
import { typedCaptureBody } from '../../apps/web-erp/src/supplier-bills-session';
import { createBillCheckSession, createPayablesBooksSession, createApTallySession, type AskedCheck } from '../../apps/web-erp/src/supplier-bills-to-the-books-session';

/**
 * **W4 · WF-05 "… PO-GRN-invoice match → discrepancy → approval → AP/Tally" — the after-match chain, through the three
 * office sessions' OWN calls against the real head-office API (in memory; the browser run on PostgreSQL is
 * tests/e2e/w4-wf05-a-supplier-bill-goes-from-its-check-to-the-tally-file-on-the-production-api.e2e.ts).**
 * A delivery comes one dal short and with two oil tins damaged (sent back: a debit note). The buyer types the bill from the
 * paper and asks a second person to check it; the bill cannot be saved naming a check that was not given; the accountant
 * approves; the buyer saves it naming the approval (checked by the accountant); the three-way match withholds the short dal;
 * the debit note is issued its DN number once; the accountant puts the supplier bills in the books through his rules — the
 * register and the books agree to the paisa; the month's supplier-bill file is accepted by Tally's import check.
 */

const sessionFetch = (h: ApiHarness, T: string, userId: string): typeof globalThis.fetch => (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url), 'http://office');
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const r = await h.request({
    method: (init?.method ?? 'GET') as 'GET' | 'POST', path: u.pathname, userId, tenantId: T,
    ...(u.search === '' ? {} : { query: Object.fromEntries(u.searchParams) }),
    ...(headers['idempotency-key'] === undefined ? {} : { idempotencyKey: headers['idempotency-key'] }),
    ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as typeof globalThis.fetch;

describe('WF-05 — a typed bill is checked by a second person, matched, its debit note issued, and it reaches the books and the Tally file', () => {
  it('runs the after-match chain on the sessions the office pages use', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await p3Shop(h, T, 'sup-k');
    await h.provisionRole(T, 'u-boss', 'store_manager');
    const call = caller(h, T);
    const ok = async (p: Promise<{ status: number; body: unknown }>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body; };

    // The order (10 rice @ ₹50, 4 dal @ ₹100, 2 oil @ ₹150) and the delivery: one dal short, both oil tins damaged.
    await issuedOrder(call, 'po-1', [{ productId: 'RICE', qty: 10, unitMinor: 5_000 }, { productId: 'DAL', qty: 4, unitMinor: 10_000 }, { productId: 'OIL', qty: 2, unitMinor: 15_000 }], 'sup-k');
    await ok(call('POST', '/v1/inventory/goods-receipt/grn-1', P3.RECEIVER, {
      warehouseId: P3.BACK, receivedOnDate: '2026-10-20', currency: 'INR', poId: 'po-1',
      lines: [
        { lineId: 'L1', productId: 'RICE', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' },
        { lineId: 'L2', productId: 'DAL', orderedMinor: 4, countedMinor: 3, uom: 'ea', unitCost: { minor: 10_000, currency: 'INR' }, condition: 'good' },
        { lineId: 'L3', productId: 'OIL', orderedMinor: 2, countedMinor: 2, uom: 'ea', unitCost: { minor: 15_000, currency: 'INR' }, condition: 'damaged' },
      ],
    }), 'delivery');
    await ok(call('POST', '/v1/inventory/goods-receipt/grn-1/lines/L3/disposition', 'u-boss', { disposition: 'return', reason: 'tins dented' }), 'send the oil back');

    // ── The buyer types the bill and asks a second person to check it ───────────────────────────────────────────────
    const buyer = createBillCheckSession({ viewer: { userId: P3.BUYER, permissions: ['purchase.invoice.capture', 'purchase.invoice.match'] }, fetch: sessionFetch(h, T, P3.BUYER) });
    const typed = typedCaptureBody({
      invoiceId: 'sup-k-KA-7', supplierId: 'sup-k', poId: 'po-1', total: '1,200',
      lines: [{ productId: 'RICE', quantity: '10', unitPrice: '50', amount: '500' }, { productId: 'DAL', quantity: '4', unitPrice: '100', amount: '400' }, { productId: 'OIL', quantity: '2', unitPrice: '150', amount: '300' }],
    });
    if (!typed.ok) throw new Error('typed');
    const asked = await buyer.askCheck({ invoiceId: typed.invoiceId, body: typed.body });
    expect(asked.result).toBe('ok');
    const mine = await buyer.asked();
    if (mine.result !== 'ok') throw new Error('asked');
    const request = mine.value[0] as AskedCheck;
    expect(request).toMatchObject({ kind: 'supplier_invoice_check', subjectRef: 'sup-k-KA-7', status: 'waiting', valueMinor: 120_000 });
    // Not yet checked: saving it naming the request is refused by head office, and nothing is on the register.
    const early = await buyer.saveChecked(request);
    expect(early.result).toBe('refused');
    expect((await call('GET', '/v1/purchase/invoices/sup-k-KA-7', P3.OWNER)).status).toBe(404);
    // The buyer may not check his own bill.
    expect((await call('POST', `/v1/approvals/requests/${request.requestId}/decide`, P3.BUYER, { decision: 'approved', reason: 'mine' })).status).toBeGreaterThanOrEqual(400);

    // ── The accountant checks it (as on his Approvals page); the buyer saves it naming the approval ──────────────────
    await ok(call('POST', `/v1/approvals/requests/${request.requestId}/decide`, P3.MATCHER, { decision: 'approved', reason: 'matches the paper' }), 'checked');
    const approved = (await buyer.asked());
    if (approved.result !== 'ok') throw new Error('asked again');
    expect(approved.value[0]?.status).toBe('approved');
    const saved = await buyer.saveChecked(approved.value[0]!);
    expect(saved).toEqual({ result: 'ok', value: { invoiceId: 'sup-k-KA-7', approvedBy: P3.MATCHER } });
    const onRegister = (await call('GET', '/v1/purchase/invoices/sup-k-KA-7', P3.OWNER)).body as { invoice: { approvedBy: string; governanceFlags: string[]; totalMinor: number } };
    expect(onRegister.invoice).toMatchObject({ approvedBy: P3.MATCHER, totalMinor: 120_000 });
    expect(onRegister.invoice.governanceFlags).not.toContain('no_approval');

    // ── The match: the short dal is withheld ─────────────────────────────────────────────────────────────────────────
    const match = await ok(call('POST', '/v1/purchase/invoices/sup-k-KA-7/match', P3.MATCHER, {}), 'match') as { blocked: boolean; payableMinor: number; withheldMinor: number };
    expect(match.blocked).toBe(true);
    expect(match.withheldMinor).toBeGreaterThan(0);

    // ── The debit note for the oil sent back: issued its number once ─────────────────────────────────────────────────
    const checker = createBillCheckSession({ viewer: { userId: P3.MATCHER, permissions: ['purchase.invoice.match'] }, fetch: sessionFetch(h, T, P3.MATCHER) });
    const acct = await checker.account('sup-k');
    if (acct.result !== 'ok') throw new Error(JSON.stringify(acct));
    expect(acct.value.debitNotes.map((d) => [d.debitNoteRef, d.valueMinor, d.number])).toEqual([['DN-grn-1-L3', 30_000, null]]);
    const issued = await checker.issueDebitNote('sup-k', 'DN-grn-1-L3');
    expect(issued).toMatchObject({ result: 'ok', value: { number: 'DN-000001', alreadyIssued: false } });
    expect(await checker.issueDebitNote('sup-k', 'DN-grn-1-L3')).toMatchObject({ result: 'ok', value: { number: 'DN-000001', alreadyIssued: true } });

    // ── The books: the accountant's rules, the posting (nothing sent), register and books agree ─────────────────────
    const books = createPayablesBooksSession({ viewer: { userId: P3.MATCHER, permissions: ['finance.period.read', 'finance.journal.post'] }, fetch: sessionFetch(h, T, P3.MATCHER) });
    const noMap = await books.post();
    expect(noMap).toMatchObject({ result: 'refused', code: 'posting_map_not_defined' });
    await ok(h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: 'map', body: DEFAULT_RETAIL_POSTING_MAP }), 'map');
    const posted = await books.post();
    if (posted.result !== 'ok') throw new Error(JSON.stringify(posted));
    expect(posted.value.journals.map((j) => j.kind).sort()).toEqual(['supplier_debit_note', 'supplier_invoice']);
    expect((await books.post())).toMatchObject({ result: 'ok', value: { journals: [] } }); // once — a re-run posts nothing
    const read = await books.read();
    if (read.result !== 'ok') throw new Error('read');
    const sup = read.value.reconciliation.suppliers?.find((s) => s.supplierId === 'sup-k');
    expect(sup).toMatchObject({ registerOwedMinor: match.payableMinor - 30_000, differenceMinor: 0, agrees: true });

    // ── The month's supplier-bill file for Tally ───────────────────────────────────────────────────────────────────
    const period = posted.value.journals[0]!.period;
    const tally = createApTallySession({ viewer: { userId: P3.MATCHER, permissions: ['finance.period.read'] }, fetch: sessionFetch(h, T, P3.MATCHER) });
    expect(await tally.vouchers(period)).toMatchObject({ result: 'refused', code: 'tally_ledgers_not_named' });
    const codes = [...new Set(posted.value.journals.flatMap((j) => j.lines.map((l) => l.accountCode)))];
    await ok(call('POST', '/v1/finance/tally/ledger-names', P3.MATCHER, { companyName: 'SRE Hyper Market (synthetic)', names: Object.fromEntries(codes.map((c) => [c, `Tally ${c}`])) }), 'ledger names');
    const file = await tally.vouchers(period);
    if (file.result !== 'ok') throw new Error(JSON.stringify(file));
    expect(file.value).toMatchObject({ empty: false, complete: true, check: { ok: true, problems: [] } });
    expect(file.value.vouchers.map((v) => v.entryId).sort()).toEqual(posted.value.journals.map((j) => j.entryId).sort());
    expect(validateTallyImport(file.value.xml!, file.value.controlTotals!).ok).toBe(true);
  });
});
