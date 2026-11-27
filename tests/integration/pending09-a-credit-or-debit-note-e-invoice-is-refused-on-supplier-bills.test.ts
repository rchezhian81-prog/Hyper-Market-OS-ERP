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
import { FakeOcrExtractor, parseGstEInvoice, type InvoiceExtractor } from '../../packages/purchasing/src/invoice-extraction';

/**
 * **OB-937 (owner decided A, 27 Nov 2026, in writing) · D-155 · D03-FR-02 · WF-05.** A GST e-invoice that is a supplier's
 * CREDIT NOTE (`DocDtls.Typ` CRN) or DEBIT NOTE (DBN) is not a bill. Head office REFUSES it on Supplier bills — 422
 * `einvoice_is_credit_note` / `einvoice_is_debit_note`, in plain words — so no path (the screen, an OCR upload, the API) can
 * turn it into a bill: nothing is written (no draft document, no bill on the register, no audit "received", nothing in the
 * books). A refused hand-in is not audited, exactly as every other refused hand-in (not an e-invoice, the same bill twice).
 * A bill (`Typ` INV, or none) is read as before. Before: a CRN/DBN was read as a draft bill a person could confirm.
 * In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart. Synthetic data only.
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
type Opts = { invoiceExtractor?: InvoiceExtractor; store?: ApiHarness['store'] };
const backings: { name: string; harness: (o?: Opts) => ApiHarness }[] = [{ name: 'the in-memory event store', harness: (o = {}) => apiHarness(o) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: (o = {}) => { const sql = pgPoolClient(pool!); return apiHarness({ ...(o.invoiceExtractor === undefined ? {} : { invoiceExtractor: o.invoiceExtractor }), store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const errorOf = (r: Res): { code?: string; whatHappened?: string; nextSafeAction?: string; wasItSaved?: string } => (r.body as { error?: Record<string, string> }).error ?? {};
const GSTIN = '33ABCDE1234F1Z5';

const eInvoice = (no: string, typ: string | undefined) => ({
  Version: '1.1', Irn: `irn-synthetic-${no}`,
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
  DocDtls: { ...(typ === undefined ? {} : { Typ: typ }), No: no, Dt: '20/11/2026' },
  SellerDtls: { Gstin: GSTIN, LglNm: 'Synthetic Agro Traders', Addr1: 'Synthetic street', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  BuyerDtls: { Gstin: '33ZZZZZ9999Z1Z9', LglNm: 'Synthetic Hyper Market', Pos: '33', Addr1: 'Synthetic road', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  ItemList: [{ SlNo: '1', PrdDesc: 'Ponni rice 1 kg', IsServc: 'N', HsnCd: '1006', Barcde: 'S-RICE', Qty: 2, Unit: 'NOS', UnitPrice: 50, TotAmt: 100, AssAmt: 100, GstRt: 5, CgstAmt: 2.5, SgstAmt: 2.5, IgstAmt: 0, TotItemVal: 105 }],
  ValDtls: { AssVal: 100, CgstVal: 2.5, SgstVal: 2.5, IgstVal: 0, TotInvVal: 105 },
});
const scan = (type: string | null, invoice: string) => Buffer.from(['SYNTHETIC-SCAN v1', `GSTIN: ${GSTIN}`, `INVOICE: ${invoice}`, 'DATE: 2026-11-20',
  ...(type === null ? [] : [`TYPE: ${type}`]), 'LINE: S-RICE|Ponni rice|1006|2|NOS|50|100|2.5|2.5|0', 'TOTAL: 105'].join('\n'), 'utf8').toString('base64');

async function shop(h: ApiHarness) {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-buyer', 'store_manager');
  await h.provisionRole(T, 'u-acct', 'accountant');
  await deliveryPlaces(h, T, 'store-1');
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${userId}-${JSON.stringify(body).length}` }) });
  const sup = await call('POST', '/v1/purchase/suppliers/sup-s', 'u-buyer', { name: 'Synthetic Agro Traders', gstin: GSTIN }, 'sup');
  expect(sup.status).toBeLessThan(300);
  expect((await call('POST', '/v1/purchase/suppliers/sup-s/approval', 'u-acct', { reason: 'documents checked' }, 'sup-ok')).status).toBeLessThan(300);
  return { T, call };
}

describe('the e-invoice reader says what kind of document it is (unit)', () => {
  it('a credit note (CRN) or debit note (DBN) is named on the draft; a bill (INV, or no Typ) is not marked', () => {
    expect(parseGstEInvoice(eInvoice('U1', 'CRN'))).toMatchObject({ ok: true, invoice: { documentType: 'CRN' } });
    expect(parseGstEInvoice(eInvoice('U2', 'dbn'))).toMatchObject({ ok: true, invoice: { documentType: 'DBN' } });
    for (const typ of ['INV', undefined]) {
      const p = parseGstEInvoice(eInvoice('U3', typ));
      expect(p.ok && 'documentType' in p.invoice, `Typ ${String(typ)} is a bill`).toBe(false);
    }
  });
  it('the OCR stand-in reads a "TYPE:" line the same way', async () => {
    const ocr = new FakeOcrExtractor();
    expect(await ocr.extract({ mediaType: 'image/png', contentBase64: scan('CRN', 'X1') })).toMatchObject({ documentType: 'CRN' });
    expect('documentType' in await ocr.extract({ mediaType: 'image/png', contentBase64: scan(null, 'X2') })).toBe(false);
  });
});

describe.each(backings)('OB-937 A — a credit or debit note e-invoice is refused on Supplier bills — on $name', ({ harness }) => {
  it('CRN and DBN are refused at head office in plain words; nothing is written; a bill (INV) still reads; after a cold restart too', async () => {
    const h = harness();
    const { T, call } = await shop(h);
    const handIn = (doc: string, bill: unknown) => call('POST', `/v1/purchase/invoice-documents/${doc}`, 'u-buyer', { kind: 'e_invoice', eInvoice: bill, supplierId: 'sup-s' }, `hand-${doc}`);

    // ── A supplier's credit note ───────────────────────────────────────────────────────────────────────────────
    const crn = await handIn('d-crn', eInvoice('CN/7', 'CRN'));
    expect(crn.status, JSON.stringify(crn.body)).toBe(422);
    expect(errorOf(crn)).toMatchObject({
      code: 'einvoice_is_credit_note', wasItSaved: 'not_saved',
      whatHappened: 'This file (CN/7 from GSTIN 33ABCDE1234F1Z5) is a supplier\'s credit note, not a bill. It was not put on Supplier bills.',
      nextSafeAction: 'Record it under Debit notes → Supplier accepted. Nothing was recorded.',
    });
    // Lower case is the same document type.
    expect(errorOf(await handIn('d-crn-lc', eInvoice('CN/8', 'crn'))).code).toBe('einvoice_is_credit_note');

    // ── A supplier's debit note ────────────────────────────────────────────────────────────────────────────────
    const dbn = await handIn('d-dbn', eInvoice('DN/3', 'DBN'));
    expect(dbn.status).toBe(422);
    expect(errorOf(dbn)).toMatchObject({
      code: 'einvoice_is_debit_note', wasItSaved: 'not_saved',
      whatHappened: 'This file (DN/3 from GSTIN 33ABCDE1234F1Z5) is a supplier\'s debit note, not a bill. It was not put on Supplier bills.',
      nextSafeAction: 'Ask the accountant how to record it. Nothing was recorded.',
    });

    // Handing the same note in again is refused again — it never became a document to answer "already received".
    expect(errorOf(await handIn('d-crn', eInvoice('CN/7', 'CRN'))).code).toBe('einvoice_is_credit_note');
    // Confirming the refused note's document is refused: there is no such document.
    expect(errorOf(await call('POST', '/v1/purchase/invoice-documents/d-crn/confirm', 'u-buyer', { invoiceId: 'inv-crn', lines: [{ lineNo: 1, productId: 'RICE' }] }, 'c-crn')).code).toBe('invoice_document_unknown');

    // ── Nothing was written: no document, no bill, no "received" on the audit trail ──────────────────────────────
    const nothingWritten = async (c: typeof call, hh: ApiHarness) => {
      const reg = (await c('GET', '/v1/purchase/invoice-documents', 'u-buyer')).body as { documents: { documentId: string }[] };
      expect(reg.documents.map((d) => d.documentId).filter((id) => id !== 'd-inv')).toEqual([]);
      expect((await c('GET', '/v1/purchase/invoices/inv-crn', 'u-acct')).status).toBe(404);
      const trail = (await hh.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { action: 'invoice.document.receive' } })).body as { matches: { objectId: string }[] };
      expect(trail.matches.map((m) => m.objectId).filter((id) => id !== 'd-inv')).toEqual([]);
    };
    await nothingWritten(call, h);

    // ── A bill (INV) still reads, and goes on the register when a person confirms it ─────────────────────────────
    const inv = await handIn('d-inv', eInvoice('SB/1', 'INV'));
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body).toMatchObject({ document: { state: 'draft', channel: 'e_invoice', supplierId: 'sup-s', extracted: { supplierInvoiceNo: 'SB/1', statedTotalMinor: 10_500 } } });
    const confirmed = await call('POST', '/v1/purchase/invoice-documents/d-inv/confirm', 'u-buyer', { invoiceId: 'inv-sb1', lines: [{ lineNo: 1, productId: 'RICE' }] }, 'c-inv');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);

    // ── A cold restart reads the same: still no note anywhere ──────────────────────────────────────────────────
    const h2 = harness({ store: h.store });
    const call2 = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string): Promise<Res> =>
      h2.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? path }) });
    await nothingWritten(call2, h2);
    expect(((await call2('GET', '/v1/purchase/invoice-documents', 'u-buyer')).body as { documents: { documentId: string; state: string }[] }).documents.map((d) => [d.documentId, d.state])).toEqual([['d-inv', 'confirmed']]);
  }, 120_000);

  it('OCR: a scan the engine reads as a credit or debit note is refused the same way; a scanned bill still reads', async () => {
    const h = harness({ invoiceExtractor: new FakeOcrExtractor() });
    const { call } = await shop(h);
    const handScan = (doc: string, type: string | null, no: string) => call('POST', `/v1/purchase/invoice-documents/${doc}`, 'u-buyer', { kind: 'scan', mediaType: 'image/jpeg', contentBase64: scan(type, no) }, `scan-${doc}`);
    const crn = await handScan('s-crn', 'CRN', 'CN/9');
    expect(crn.status).toBe(422);
    expect(errorOf(crn)).toMatchObject({ code: 'einvoice_is_credit_note', nextSafeAction: 'Record it under Debit notes → Supplier accepted. Nothing was recorded.' });
    expect(errorOf(await handScan('s-dbn', 'DBN', 'DN/9')).code).toBe('einvoice_is_debit_note');
    expect((await handScan('s-inv', null, 'SB/9')).status).toBe(201);
    const reg = (await call('GET', '/v1/purchase/invoice-documents', 'u-buyer')).body as { documents: { documentId: string }[] };
    expect(reg.documents.map((d) => d.documentId)).toEqual(['s-inv']);
  }, 120_000);
});
