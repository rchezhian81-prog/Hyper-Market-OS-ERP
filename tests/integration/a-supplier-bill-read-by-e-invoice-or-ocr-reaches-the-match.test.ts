import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { FakeOcrExtractor, parseGstEInvoice, rupeesToPaise, type InvoiceExtractor } from '../../packages/purchasing/src/invoice-extraction';

/**
 * **D03-FR-02 · WF-05 "Capture/OCR/import" (round 8).** On the real API, in memory and — with DATABASE_URL — on real
 * PostgreSQL: a supplier's GST e-invoice (parsed here) or a scanned bill (read by the OCR engine behind its port — the
 * deterministic fake; no live engine) becomes a DRAFT; the supplier is found by GSTIN; a person maps every line to a product
 * and types the figures of any line the engine was unsure of; only then does the bill go onto the supplier-invoice register
 * (through the same capture the portal uses) and into the three-way match by a second person. The same bill twice is
 * refused; without an engine a scan waits for typing, said; a confirmed mapping is suggested on the supplier's next bill.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
type Opts = { invoiceExtractor?: InvoiceExtractor };
const backings: { name: string; harness: (o?: Opts) => ApiHarness }[] = [{ name: 'the in-memory event store', harness: (o = {}) => apiHarness(o) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: (o = {}) => { const sql = pgPoolClient(pool!); return apiHarness({ ...o, store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const GSTIN = '33ABCDE1234F1Z5';
const IRN = 'a5c12dca80e743321740b001fd70953e8738d109865d28ba4013750f2046f229';

const eInvoice = (no = 'KA/101', irn = IRN) => ({
  Version: '1.1', Irn: irn,
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
  DocDtls: { Typ: 'INV', No: no, Dt: '05/10/2026' },
  SellerDtls: { Gstin: GSTIN, LglNm: 'Kaveri Agro Traders', Addr1: 'Synthetic street', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  BuyerDtls: { Gstin: '33ZZZZZ9999Z1Z9', LglNm: 'SRE Hyper Market', Pos: '33', Addr1: 'Synthetic road', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  ItemList: [
    { SlNo: '1', PrdDesc: 'Ponni rice 1 kg', IsServc: 'N', HsnCd: '1006', Barcde: 'K-RICE', Qty: 10, Unit: 'NOS', UnitPrice: 50, TotAmt: 500, AssAmt: 500, GstRt: 5, CgstAmt: 12.5, SgstAmt: 12.5, IgstAmt: 0, TotItemVal: 525 },
    { SlNo: '2', PrdDesc: 'Toor dal 500 g', IsServc: 'N', HsnCd: '0713', Barcde: 'K-DAL', Qty: 4, Unit: 'NOS', UnitPrice: 100, TotAmt: 400, AssAmt: 400, GstRt: 5, CgstAmt: 10, SgstAmt: 10, IgstAmt: 0, TotItemVal: 420 },
  ],
  ValDtls: { AssVal: 900, CgstVal: 22.5, SgstVal: 22.5, IgstVal: 0, TotInvVal: 945 },
});
const scan = (lines: string[], invoice = 'INV-77') => Buffer.from(['SYNTHETIC-SCAN v1', `GSTIN: ${GSTIN}`, `INVOICE: ${invoice}`, 'DATE: 2026-10-06', ...lines].join('\n'), 'utf8').toString('base64');

async function shop(harness: (o?: Opts) => ApiHarness, o: Opts = {}) {
  const h = harness(o);
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-buyer', 'store_manager');
  await h.provisionRole(T, 'u-checker', 'store_manager');
  await h.provisionRole(T, 'u-acct', 'accountant');
  await h.provisionRole(T, 'u-till', 'cashier');
  await deliveryPlaces(h, T, 'store-1');
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${userId}-${JSON.stringify(body).length}` }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  // The supplier, with its GSTIN, in the master (proposed by one person, approved by finance).
  await ok(call('POST', '/v1/purchase/suppliers/sup-k', 'u-buyer', { name: 'Kaveri Agro Traders', gstin: GSTIN }, 'sup'), 'supplier');
  await ok(call('POST', '/v1/purchase/suppliers/sup-k/approval', 'u-acct', { reason: 'documents checked' }, 'sup-ok'), 'supplier approved');
  // An issued order and the delivery against it: 10 rice @ ₹50, 4 dal @ ₹100.
  await ok(call('POST', '/v1/purchase/orders/po-1', 'u-buyer', { supplierId: 'sup-k', deliverToLocationId: 'store-1', lines: [{ productId: 'RICE', orderedQty: 10, unitCost: { minor: 5_000, currency: 'INR' } }, { productId: 'DAL', orderedQty: 4, unitCost: { minor: 10_000, currency: 'INR' } }] }, 'po-1'), 'po');
  await ok(call('POST', '/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'weekly order' }, 'po-1-ok'), 'po approved');
  await ok(call('POST', '/v1/inventory/goods-receipt/grn-1', 'u-owner', {
    warehouseId: 'store-1', receivedOnDate: '2026-10-05', currency: 'INR', poId: 'po-1',
    lines: [
      { lineId: 'L1', productId: 'RICE', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' },
      { lineId: 'L2', productId: 'DAL', orderedMinor: 4, countedMinor: 4, uom: 'ea', unitCost: { minor: 10_000, currency: 'INR' }, condition: 'good' },
    ],
  }, 'grn-1'), 'delivery');
  return { call, ok };
}

describe('the e-invoice parser reads rupees exactly and says what it cannot read (unit)', () => {
  it('turns decimal rupees into paise from the text, kg into grams, and lists an unknown unit, a discount and the unverified signature', () => {
    expect([rupeesToPaise(12.5), rupeesToPaise('0.07'), rupeesToPaise(1155), rupeesToPaise('1.005'), rupeesToPaise('-1')]).toEqual([1_250, 7, 115_500, undefined, undefined]);
    const parsed = parseGstEInvoice({ ...eInvoice(), ItemList: [
      { PrdDesc: 'Sugar', HsnCd: '1701', Qty: 2.5, Unit: 'KGS', UnitPrice: 44, TotAmt: 110, CgstAmt: 2.75, SgstAmt: 2.75 },
      { PrdDesc: 'Rope', HsnCd: '5607', Qty: 3, Unit: 'MTR', UnitPrice: 10, TotAmt: 30, Discount: 5 },
    ] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.invoice.lines[0]).toMatchObject({ quantity: 2_500, uom: 'kg', unitPriceMinor: 4_400, lineTotalMinor: 11_000, cgstMinor: 275, sgstMinor: 275, confidence: 1 });
    expect(parsed.invoice.lines[1]).toMatchObject({ quantity: null, uom: null });
    expect(parsed.invoice.warnings).toEqual(expect.arrayContaining(['irp_signature_not_verified', 'line 2: unit "MTR" is not one the store counts in', expect.stringMatching(/line 2: a discount of 500 paise/)]));
    expect(parseGstEInvoice({ DocDtls: {} })).toMatchObject({ ok: false });
  });
});

describe.each(backings)('a supplier bill read by e-invoice or OCR reaches the three-way match through a person — on $name (D03-FR-02)', ({ harness }) => {
  it('e-invoice: a draft, the supplier by GSTIN, every line mapped by a person, onto the register, matched by a second person; the same bill twice refused', async () => {
    const { call, ok } = await shop(harness);
    expect((await call('POST', '/v1/purchase/invoice-documents/d1', 'u-till', { kind: 'e_invoice', eInvoice: eInvoice() }, 'd1-till')).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/purchase/invoice-documents/d0', 'u-buyer', { kind: 'e_invoice', eInvoice: { hello: 'world' } }, 'd0'))).toBe('not_a_gst_e_invoice');
    const received = await ok(call('POST', '/v1/purchase/invoice-documents/d1', 'u-buyer', { kind: 'e_invoice', eInvoice: eInvoice(), poId: 'po-1' }, 'd1'), 'receive');
    const doc = (received.body as { document: { state: string; supplierId: string; channel: string; extracted: { irn: string; supplierInvoiceNo: string; statedTotalMinor: number }; lines: { lineNo: number; supplierItemCode: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number; cgstMinor: number; suggestedProductId: string | null; needsFigures: boolean }[]; problems: string[] } }).document;
    expect(doc).toMatchObject({ state: 'draft', channel: 'e_invoice', supplierId: 'sup-k', extracted: { irn: IRN, supplierInvoiceNo: 'KA/101', statedTotalMinor: 94_500 } });
    expect(doc.lines.map((l) => [l.supplierItemCode, l.quantity, l.unitPriceMinor, l.lineTotalMinor, l.cgstMinor, l.suggestedProductId, l.needsFigures])).toEqual([['K-RICE', 10, 5_000, 50_000, 1_250, null, false], ['K-DAL', 4, 10_000, 40_000, 1_000, null, false]]);
    expect(doc.problems).toContain('irp_signature_not_verified');
    // Nothing is on the register yet: the machine read it, nobody committed it.
    expect(((await call('GET', '/v1/purchase/invoices', 'u-owner')).body as { count: number }).count).toBe(0);
    // The same bill again — by its IRN, or by the same number from the same GSTIN — is refused by name.
    expect(codeOf(await call('POST', '/v1/purchase/invoice-documents/d1b', 'u-buyer', { kind: 'e_invoice', eInvoice: eInvoice() }, 'd1b'))).toBe('bill_already_received');
    expect(codeOf(await call('POST', '/v1/purchase/invoice-documents/d1c', 'u-buyer', { kind: 'e_invoice', eInvoice: eInvoice('KA/101', 'other-irn') }, 'd1c'))).toBe('bill_already_received');

    // A person maps every line; one left unmapped is refused and nothing is recorded.
    const half = await call('POST', '/v1/purchase/invoice-documents/d1/confirm', 'u-buyer', { invoiceId: 'inv-ka-101', lines: [{ lineNo: 1, productId: 'RICE' }] }, 'c-half');
    expect(half.status).toBe(422);
    expect(codeOf(half)).toBe('lines_need_a_person');
    const confirmed = await ok(call('POST', '/v1/purchase/invoice-documents/d1/confirm', 'u-buyer', { invoiceId: 'inv-ka-101', lines: [{ lineNo: 1, productId: 'RICE' }, { lineNo: 2, productId: 'DAL' }] }, 'c-1'), 'confirm');
    expect(confirmed.body).toMatchObject({ document: { state: 'confirmed', confirmedBy: 'u-buyer', invoiceId: 'inv-ka-101' }, invoice: { invoiceId: 'inv-ka-101', supplierId: 'sup-k', poId: 'po-1', totalMinor: 94_500, capturedBy: 'u-buyer', approvedBy: null, source: `e-invoice/${IRN}`, governanceFlags: ['no_approval'] } });
    expect((await call('POST', '/v1/purchase/invoice-documents/d1/confirm', 'u-buyer', { invoiceId: 'inv-ka-101', lines: [] }, 'c-again')).body).toMatchObject({ alreadyConfirmed: true });
    // The three-way match by a SECOND person over what head office holds: everything agrees, the whole bill is payable.
    const m = await ok(call('POST', '/v1/purchase/invoices/inv-ka-101/match', 'u-checker', {}, 'm-1'), 'match');
    expect(m.body).toMatchObject({ invoiceId: 'inv-ka-101', poId: 'po-1', blocked: false, payableMinor: 94_500, lines: [{ productId: 'DAL', status: 'matched' }, { productId: 'RICE', status: 'matched' }] });
  });

  it('OCR: with no engine the scan waits for typing (said); with the engine a smudged line needs the figures from the paper; a confirmed code is suggested next time', async () => {
    const without = await shop(harness);
    const waiting = await without.ok(without.call('POST', '/v1/purchase/invoice-documents/s0', 'u-buyer', { kind: 'scan', mediaType: 'image/jpeg', contentBase64: scan(['LINE: K-RICE|Ponni rice|1006|10|NOS|50|500|12.5|12.5|0']) }, 's0'), 'scan with no engine');
    expect(waiting.body).toMatchObject({ document: { state: 'awaiting_manual_capture', channel: 'ocr', extracted: null, problems: ['no OCR engine is connected: type this bill on the capture screen'] } });
    expect((waiting.body as { document: { scan: { sha256: string; bytes: number } } }).document.scan.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(waiting.body)).not.toContain('U1lOVEhFVElD'); // the scan's bytes are not kept
    expect(codeOf(await without.call('POST', '/v1/purchase/invoice-documents/s0/confirm', 'u-buyer', { invoiceId: 'x', lines: [] }, 's0-c'))).toBe('nothing_read_to_confirm');
    expect(codeOf(await without.call('POST', '/v1/purchase/invoice-documents/s-pdf', 'u-buyer', { kind: 'scan', mediaType: 'text/html', contentBase64: 'AAAA' }, 's-pdf'))).toBe('not_readable_as_a_scan');

    const { call, ok } = await shop(harness, { invoiceExtractor: new FakeOcrExtractor() });
    // Line 2's amount is smudged ("400?") — the engine is unsure of it.
    const read = await ok(call('POST', '/v1/purchase/invoice-documents/s1', 'u-buyer', { kind: 'scan', mediaType: 'image/jpeg', poId: 'po-1', contentBase64: scan(['LINE: K-RICE|Ponni rice|1006|10|NOS|50|500|12.5|12.5|0', 'LINE: K-DAL|Toor dal|0713|4|NOS|100|400?|10|10|0', 'TOTAL: 945']) }, 's1'), 'scan');
    const draft = (read.body as { document: { state: string; supplierId: string; lines: { needsFigures: boolean; confidence: number }[] } }).document;
    expect(draft).toMatchObject({ state: 'draft', supplierId: 'sup-k' });
    expect(draft.lines.map((l) => [l.needsFigures, l.confidence])).toEqual([[false, 0.97], [true, 0.6]]);
    const untyped = await call('POST', '/v1/purchase/invoice-documents/s1/confirm', 'u-buyer', { invoiceId: 'inv-77', lines: [{ lineNo: 1, productId: 'RICE' }, { lineNo: 2, productId: 'DAL' }] }, 's1-c1');
    expect(codeOf(untyped)).toBe('lines_need_a_person');
    expect((untyped.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/Line\(s\) 2 were read with low confidence/);
    // Typed from the paper: the line multiplies, the bill adds up, it goes on the register.
    const done = await ok(call('POST', '/v1/purchase/invoice-documents/s1/confirm', 'u-buyer', { invoiceId: 'inv-77', lines: [{ lineNo: 1, productId: 'RICE' }, { lineNo: 2, productId: 'DAL', quantity: 4, unitPriceMinor: 10_000, lineTotalMinor: 40_000 }] }, 's1-c2'), 'confirm typed');
    expect(done.body).toMatchObject({ invoice: { invoiceId: 'inv-77', totalMinor: 94_500, source: 'ocr/s1' } });
    // The supplier's next bill: the codes a person confirmed are SUGGESTED (never committed) on the new draft.
    const next = await ok(call('POST', '/v1/purchase/invoice-documents/s2', 'u-buyer', { kind: 'scan', mediaType: 'image/png', contentBase64: scan(['LINE: K-DAL|Toor dal|0713|2|NOS|100|200|5|5|0'], 'INV-78') }, 's2'), 'next scan');
    expect((next.body as { document: { lines: { suggestedProductId: string | null }[] } }).document.lines[0]?.suggestedProductId).toBe('DAL');
    expect(((await call('GET', '/v1/purchase/invoice-documents', 'u-buyer')).body as { waiting: number; documents: { documentId: string; state: string }[] }).documents.map((d) => [d.documentId, d.state])).toEqual([['s2', 'draft'], ['s1', 'confirmed']]);
  });
});
