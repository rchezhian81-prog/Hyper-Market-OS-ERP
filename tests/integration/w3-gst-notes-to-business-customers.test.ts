import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { setApprovedCreditLimit } from '../support/approved-credit-limit';
import { onThePriceList, harnessPriceList } from '../support/b2b-price-on-record';
import { theEvening, pinTheEveningClock } from '../support/evening-clock';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { InMemoryNumberSeriesStore, SqlNumberSeriesStore } from '../../packages/persistence/src/number-series-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **M23-FR-02 · OB-678 (owner, 2 Nov 2026, in writing) — GST credit and debit notes to business customers, on the real
 * head-office API (in memory and, with DATABASE_URL, on real PostgreSQL), with the shop's clock pinned to the small hours
 * (01:00 in the shop, the UTC date still yesterday).**
 *
 *   • a note is raised only against the business tax invoice head office holds — looked up, never taken from the request;
 *     a till receipt or another customer's invoice is refused by name; the invoice is never changed;
 *   • the tax comes off each line as the invoice charged it, and never more than the invoice less earlier notes carries;
 *   • a CREDIT note is a refund under the money limits (OB-290): issued only on a second person's approval of exactly it —
 *     the store manager up to ₹5,000, the owner any amount; the maker never approves it; the accountant holds no limit;
 *   • OB-679: a credit note the OWNER raises is approved by the accountant at any amount (never by the owner himself), and
 *     EVERY debit note needs a second, different person's approval at any amount — no money ladder;
 *   • customer credit notes (CN-) and debit notes (CDN-) each draw their own gap-free series, apart from the supplier DN;
 *   • the notes move the customer's balance, appear in the GSTR-1 data's credit/debit-note section dated by the shop's
 *     day, and reach the books only through the accountant's own posting rule — until it is written each note shows
 *     "waiting for the accountant's posting rule", and the posting run says so, never silent.
 * Every GSTIN here is synthetic.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const EVENING = theEvening();
let pool: Pool | undefined;
beforeAll(async () => {
  pinTheEveningClock(EVENING);
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); vi.useRealTimers(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness({ store: new InMemoryEventStore(), numberSeries: new InMemoryNumberSeriesStore() }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), numberSeries: new SqlNumberSeriesStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const GSTIN_BUYER = '33ZZZZZ9999Z1ZF';
const STORE_GSTIN = '33AABCS1429B1Z1';
// 200 × ₹100 @ 5% → ₹20,000 + ₹1,000 GST (₹500 CGST + ₹500 SGST) = ₹21,000.
const LINES = [{ lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 200, unitPriceMinor: 10_000, taxRateBps: 500 }];

interface Refusal { error: { code: string; whatHappened: string; wasItSaved: string } }
interface NoteRow { number: string; kind: string; grossMinor: number; taxMinor: number; issuedOn: string; approvedBy?: string; posting: { state: string } }

describe.each(backings)('M23-FR-02 · OB-678 — GST notes to a business customer — on $name', ({ harness }) => {
  it('looked-up invoice, capped lines, refund-limit approval, own series, balance, GSTR-1 section and the accountant\'s posting rule', async () => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner');
    await h.enableFeature(t, 'b2b');
    await h.provisionRole(t, 'u-acct', 'accountant');
    await h.provisionRole(t, 'u-mgr', 'store_manager');
    await h.provisionRole(t, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const code = (r: { body: unknown }) => (r.body as Refusal).error?.code;

    // The store's GSTIN (Tamil Nadu), rice's HSN, stock; a credit customer with a GSTIN; 100 bags delivered and invoiced.
    await ok(call('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' }), 'company');
    await ok(call('POST', `/v1/org/gst-registrations/${STORE_GSTIN}`, 'u-owner', { companyId: 'SRE', legalName: 'SRE Hyper Market Private Limited' }), 'GST registration');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE', gstin: STORE_GSTIN, placeOfBusiness: '12 Main Road\n\nTiruppur 641601, Tamil Nadu' }), 'store');
    const at = new Date().toISOString();
    await h.store.append(t, STREAM.catalogue, makeEvent({
      id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: at, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: t, version: 1, builtAt: at, products: [{ productId: 'p1', sku: 'p1', name: 'Rice 25kg', unitPriceMinor: 10_000, taxBps: 500, hsnCode: '1006', status: 'active', uom: 'ea' }], barcodes: [] } },
    }));
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rice-in', productId: 'p1', locationId: 'S1', kind: 'received', quantityMinor: 300, uom: 'ea', occurredAt: at, enteredBy: 'u-owner' }), 'stock');
    await ok(setApprovedCreditLimit(h, t, 'u-owner', 'CUST1', { creditLimitMinor: 10_000_000, paymentTermsDays: 30 }, { checker: 'u-acct' }), 'terms');
    await ok(call('POST', '/v1/b2b/accounts/CUST1/gstin', 'u-acct', { gstin: GSTIN_BUYER, legalName: 'Synthetic School Trust', reason: 'GST certificate on file' }), 'gstin');
    await ok(call('POST', '/v1/b2b/documents/CUST1/quotations/q1', 'u-owner', { lines: await onThePriceList(harnessPriceList(h, t), 'CUST1', LINES) }), 'quote');
    await ok(call('POST', '/v1/b2b/documents/CUST1/orders/so1', 'u-owner', { fromQuotationId: 'q1', locationId: 'S1' }), 'order');
    await ok(call('POST', '/v1/b2b/documents/CUST1/challans/dc1', 'u-owner', { fromOrderId: 'so1', dispatched: { l1: 200 } }), 'challan');
    const inv = (await ok(call('POST', '/v1/b2b/documents/CUST1/invoices/inv1', 'u-owner', { fromOrderId: 'so1' }), 'invoice')).body as { number: string; grossMinor: number };
    expect(inv.grossMinor).toBe(2_100_000);
    const invoiceBefore = (await call('GET', '/v1/b2b/documents/CUST1/inv1', 'u-acct')).body;
    const owed = async () => ((await call('GET', '/v1/b2b/accounts/CUST1', 'u-acct')).body as { outstandingMinor: number }).outstandingMinor;
    expect(await owed()).toBe(2_100_000);

    const cn = (noteId: string, rupeesOff: number, over: Record<string, unknown> = {}) => ({ noteId, kind: 'credit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: 'goods_returned', lines: [{ lineId: 'l1', taxableMinor: rupeesOff * 100 }], ...over });

    // ── Never from the body; only an invoice head office holds; a cashier cannot.
    expect(code(await call('POST', '/v1/finance/credit-notes', 'u-acct', { ...cn('N-x', 200), invoice: { invoiceId: 'inv1', taxableMinor: 99_999_999 } }))).toBe('invoice_is_looked_up');
    const till = await call('POST', '/v1/finance/credit-notes/preview', 'u-acct', cn('N-x', 200, { invoiceDocumentId: 'RCP-000042' }));
    expect([till.status, code(till)]).toEqual([404, 'not_a_business_tax_invoice']);
    expect((till.body as Refusal).error.whatHappened).toMatch(/refunded at the till \(WF-11\)/);
    expect(code(await call('POST', '/v1/finance/credit-notes/preview', 'u-acct', cn('N-x', 200, { customerId: 'CUST2' })))).toBe('not_a_business_tax_invoice');
    expect((await call('POST', '/v1/finance/credit-notes/preview', 'u-cash', cn('N-x', 200))).status).toBe(403);
    expect(code(await call('POST', '/v1/finance/credit-notes/preview', 'u-acct', cn('N-x', 20_001)))).toBe('exceeds_invoice');

    // ── ₹200 back: worked out from the invoice (₹5 CGST + ₹5 SGST), asked of a second person; the maker cannot approve it.
    const pv = (await ok(call('POST', '/v1/finance/credit-notes/preview', 'u-acct', cn('N-1', 200)), 'preview')).body as { note: { grossMinor: number; cgstMinor: number; sgstMinor: number }; approval: { kind: string; subjectRef: string; valueMinor: number; details: unknown; summary: string } };
    expect(pv.note).toMatchObject({ grossMinor: 21_000, cgstMinor: 500, sgstMinor: 500 });
    expect(code(await call('POST', '/v1/finance/credit-notes', 'u-acct', cn('N-1', 200)))).toBe('credit_note_needs_approval');
    const ask = async (a: typeof pv.approval) => ((await ok(call('POST', '/v1/approvals/requests', 'u-acct', { ...a, reason: 'goods returned' }), 'ask')).body as { requestId: string }).requestId;
    const r1 = await ask(pv.approval);
    expect((await call('POST', `/v1/approvals/requests/${r1}/decide`, 'u-acct', { decision: 'approved', reason: 'mine' })).status).toBe(403); // the accountant holds no approval authority
    await ok(call('POST', `/v1/approvals/requests/${r1}/decide`, 'u-mgr', { decision: 'approved', reason: 'goods seen back in the store' }), 'manager approves ₹210');
    // The approval is for exactly this note: a different value is refused.
    expect(code(await call('POST', '/v1/finance/credit-notes', 'u-acct', { ...cn('N-1', 300), approvalId: r1 }))).toBe('approval_does_not_match');
    const n1 = (await ok(call('POST', '/v1/finance/credit-notes', 'u-acct', { ...cn('N-1', 200), approvalId: r1 }), 'issue N-1')).body as { number: string; approvedBy: string; invoiceUnchanged: boolean; posting: { state: string }; note: { issuedOn: string; declareInPeriod: string } };
    expect(n1).toMatchObject({ number: 'CN-000001', approvedBy: 'u-mgr', invoiceUnchanged: true, posting: { state: 'waiting_for_posting_rule' } });
    // The note is dated by the shop's day (01:00 in the shop, the UTC date still yesterday).
    expect(n1.note.issuedOn).toBe(EVENING.shopDate);
    expect(n1.note.declareInPeriod).toBe(EVENING.shopDate.slice(0, 7));
    expect(code(await call('POST', '/v1/finance/credit-notes', 'u-acct', { ...cn('N-1b', 200), approvalId: r1 }))).toBe('approval_already_used'); // one approval, one note

    // ── ₹6,000 back (₹6,300 with GST): above the store manager's ₹5,000 refund limit — it goes to the owner.
    const big = ((await ok(call('POST', '/v1/finance/credit-notes/preview', 'u-acct', cn('N-2', 6_000)), 'preview big')).body as typeof pv).approval;
    expect(big.valueMinor).toBe(630_000);
    const r2 = await ask(big);
    const inbox = (await call('GET', '/v1/approvals/requests', 'u-mgr')).body as { waitingForMe: { requestId: string }[]; routedToOwnerAboveYourLimit: number };
    expect(inbox.waitingForMe.map((r) => r.requestId)).not.toContain(r2);
    expect(inbox.routedToOwnerAboveYourLimit).toBe(1);
    expect(code(await call('POST', `/v1/approvals/requests/${r2}/decide`, 'u-mgr', { decision: 'approved', reason: 'ok' }))).toBe('exceeds_your_limit');
    await ok(call('POST', `/v1/approvals/requests/${r2}/decide`, 'u-owner', { decision: 'approved', reason: 'agreed with the school' }), 'owner approves ₹6,300');
    expect(((await ok(call('POST', '/v1/finance/credit-notes', 'u-acct', { ...cn('N-2', 6_000), approvalId: r2 }), 'issue N-2')).body as { number: string }).number).toBe('CN-000002');

    // ── OB-679: a ₹7,000 credit note the OWNER raises (₹7,350 with GST) — the accountant approves it at any amount; the owner
    //    never approves his own, and the store manager is still bound by his ₹5,000 limit.
    const ownerPv = ((await ok(call('POST', '/v1/finance/credit-notes/preview', 'u-owner', cn('N-3', 7_000)), 'owner preview')).body as typeof pv).approval;
    expect(ownerPv.valueMinor).toBe(735_000);
    const r3 = ((await ok(call('POST', '/v1/approvals/requests', 'u-owner', { ...ownerPv, reason: 'the school returned a delivery' }), 'owner asks')).body as { requestId: string; raisedByTheOwner?: boolean }).requestId;
    expect(code(await call('POST', `/v1/approvals/requests/${r3}/decide`, 'u-owner', { decision: 'approved', reason: 'mine' }))).toBe('self_approval');
    expect(code(await call('POST', `/v1/approvals/requests/${r3}/decide`, 'u-mgr', { decision: 'approved', reason: 'ok' }))).toBe('exceeds_your_limit');
    const accountantInbox = (await call('GET', '/v1/approvals/requests', 'u-acct')).body as { waitingForMe: { requestId: string }[] };
    expect(accountantInbox.waitingForMe.map((r) => r.requestId)).toContain(r3);
    await ok(call('POST', `/v1/approvals/requests/${r3}/decide`, 'u-acct', { decision: 'approved', reason: 'checked against the returned delivery' }), 'accountant approves the owner\'s ₹7,350');
    expect(((await ok(call('POST', '/v1/finance/credit-notes', 'u-owner', { ...cn('N-3', 7_000), approvalId: r3 }), 'issue N-3')).body as { number: string; approvedBy: string })).toMatchObject({ number: 'CN-000003', approvedBy: 'u-acct' });
    // The accountant still has no limit for anybody else's credit note (r1 above: refused).

    // ── What is left on the line is ₹6,800: ₹6,801 is refused, before any approval is asked.
    expect(code(await call('POST', '/v1/finance/credit-notes/preview', 'u-acct', cn('N-4', 6_801)))).toBe('exceeds_invoice');

    // ── OB-679: a ₹6,000 debit note (price charged too low) needs a second, different person at ANY amount — the store manager
    //    approves it although it is above his ₹5,000 refund limit (no money ladder); the maker cannot; its own series.
    const debit = { noteId: 'D-1', kind: 'debit_note', customerId: 'CUST1', invoiceDocumentId: 'inv1', reason: 'price_correction', lines: [{ lineId: 'l1', taxableMinor: 600_000 }] };
    expect(code(await call('POST', '/v1/finance/credit-notes', 'u-acct', debit))).toBe('debit_note_needs_approval');
    const dPv = ((await ok(call('POST', '/v1/finance/credit-notes/preview', 'u-acct', debit), 'debit preview')).body as typeof pv).approval;
    expect(dPv).toMatchObject({ kind: 'customer_debit_note', valueMinor: 630_000 });
    const rd = await ask(dPv);
    expect((await call('POST', `/v1/approvals/requests/${rd}/decide`, 'u-acct', { decision: 'approved', reason: 'mine' })).status).toBe(403); // the maker never approves
    await ok(call('POST', `/v1/approvals/requests/${rd}/decide`, 'u-mgr', { decision: 'approved', reason: 'the price list was wrong' }), 'manager approves the ₹6,300 debit note');
    const d1 = (await ok(call('POST', '/v1/finance/credit-notes', 'u-acct', { ...debit, approvalId: rd }), 'debit')).body as { number: string; approvedBy: string };
    expect(d1).toMatchObject({ number: 'CDN-000001', approvedBy: 'u-mgr' });
    expect(code(await call('POST', '/v1/finance/credit-notes', 'u-acct', { ...debit, noteId: 'D-2', approvalId: rd }))).toBe('approval_already_used'); // one approval, one note

    // ── The invoice is unchanged; the customer's balance moved by each note's whole value.
    expect((await call('GET', '/v1/b2b/documents/CUST1/inv1', 'u-acct')).body).toEqual(invoiceBefore);
    expect(await owed()).toBe(2_100_000 - 21_000 - 630_000 - 735_000 + 630_000);

    // ── The office list: each invoice line with what is left; each note with where it stands in the books.
    const desk = (await call('GET', '/v1/finance/credit-notes/customers/CUST1', 'u-acct')).body as { invoices: { number: string; lines: { chargedMinor: number; creditedMinor: number; leftMinor: number }[] }[]; notes: NoteRow[] };
    expect(desk.invoices).toEqual([expect.objectContaining({ number: inv.number, recipientGstin: GSTIN_BUYER, hasGstSplit: true, lines: [expect.objectContaining({ chargedMinor: 2_000_000, creditedMinor: 1_320_000, leftMinor: 680_000 })] })]);
    expect(desk.notes.map((n) => [n.number, n.kind, n.grossMinor, n.approvedBy ?? null, n.posting.state])).toEqual([
      ['CDN-000001', 'debit_note', 630_000, 'u-mgr', 'waiting_for_posting_rule'],
      ['CN-000001', 'credit_note', 21_000, 'u-mgr', 'waiting_for_posting_rule'],
      ['CN-000002', 'credit_note', 630_000, 'u-owner', 'waiting_for_posting_rule'],
      ['CN-000003', 'credit_note', 735_000, 'u-acct', 'waiting_for_posting_rule'],
    ]);

    // ── GSTR-1: the credit/debit-note section of the shop's month, under the buyer's GSTIN.
    const month = EVENING.shopDate.slice(0, 7);
    const ret = (await call('GET', '/v1/finance/gstr1/return', 'u-acct', undefined, { from: `${month}-01`, to: `${month}-31` })).body as { creditDebitNotes: { registered: { noteNumber: string; noteType: string; recipientGstin: string; againstInvoiceNumber: string; noteValueMinor: number }[]; creditTaxMinor: number; debitTaxMinor: number; inGstnFile: boolean } };
    expect(ret.creditDebitNotes.registered.map((r) => [r.noteNumber, r.noteType, r.recipientGstin, r.againstInvoiceNumber, r.noteValueMinor])).toEqual([
      ['CDN-000001', 'D', GSTIN_BUYER, inv.number, 630_000], ['CN-000001', 'C', GSTIN_BUYER, inv.number, 21_000], ['CN-000002', 'C', GSTIN_BUYER, inv.number, 630_000],
      ['CN-000003', 'C', GSTIN_BUYER, inv.number, 735_000],
    ]);
    expect(ret.creditDebitNotes).toMatchObject({ creditTaxMinor: 1_000 + 30_000 + 35_000, debitTaxMinor: 30_000, inGstnFile: false });

    // ── The books: with the suggested map (no note rule) the invoice posts and every note waits, said by name.
    await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP), 'map without a note rule');
    const run1 = (await call('POST', '/v1/finance/b2b/post', 'u-acct', {})).body as { posted: { entryId: string }[]; exceptions: { sourceId: string; reason: string }[] };
    expect(run1.posted.map((j) => j.entryId)).toEqual([`b2b:invoice:CUST1:inv1`]);
    expect(run1.exceptions.map((e) => [e.sourceId, e.reason]).sort()).toEqual([['credit_note:CUST1:N-1', 'unmapped_kind'], ['credit_note:CUST1:N-2', 'unmapped_kind'], ['credit_note:CUST1:N-3', 'unmapped_kind'], ['debit_note:CUST1:D-1', 'unmapped_kind']]);
    // The accountant writes HIS rule for credit notes (these account names are this test's, not a suggestion).
    const rule = { kind: 'b2b:credit_note', legs: [{ account: 'sales_returns', side: 'debit', component: 'net' }, { account: 'gst_output', side: 'debit', component: 'tax' }, { account: 'trade_receivables', side: 'credit', component: 'total' }] };
    await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', { rules: [...DEFAULT_RETAIL_POSTING_MAP.rules, rule] }), 'map with the credit-note rule');
    const run2 = (await call('POST', '/v1/finance/b2b/post', 'u-acct', {})).body as { posted: { entryId: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[]; exceptions: { sourceId: string }[] };
    expect(run2.posted.map((j) => j.entryId).sort()).toEqual(['b2b:credit_note:CUST1:N-1', 'b2b:credit_note:CUST1:N-2', 'b2b:credit_note:CUST1:N-3']);
    expect(run2.posted.find((j) => j.entryId === 'b2b:credit_note:CUST1:N-1')!.lines).toEqual([
      { accountCode: 'sales_returns', debitMinor: 20_000, creditMinor: 0 }, { accountCode: 'gst_output', debitMinor: 1_000, creditMinor: 0 }, { accountCode: 'trade_receivables', debitMinor: 0, creditMinor: 21_000 },
    ]);
    expect(run2.exceptions.map((e) => e.sourceId)).toEqual(['debit_note:CUST1:D-1']); // still waiting — said, never silent
    const after = ((await call('GET', '/v1/finance/credit-notes/customers/CUST1', 'u-acct')).body as { notes: NoteRow[] }).notes;
    expect(after.map((n) => [n.number, n.posting.state])).toEqual([['CDN-000001', 'waiting_for_posting_rule'], ['CN-000001', 'posted'], ['CN-000002', 'posted'], ['CN-000003', 'posted']]);

    // ── Audited: who issued each note and the approval behind a credit note.
    const trail = (await h.store.readStream(t, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' }))
      .map((e) => e.event.payload as { action: string; actorId: string; approvalId?: string; after: Record<string, string> | null })
      .filter((a) => a.action.startsWith('finance.') && a.action.endsWith('_note.issue'));
    expect(trail.map((a) => [a.action, a.actorId, a.after?.['number'], a.approvalId ?? null])).toEqual([
      ['finance.credit_note.issue', 'u-acct', 'CN-000001', r1], ['finance.credit_note.issue', 'u-acct', 'CN-000002', r2], ['finance.credit_note.issue', 'u-owner', 'CN-000003', r3], ['finance.debit_note.issue', 'u-acct', 'CDN-000001', rd],
    ]);
  }, 120_000);
});
