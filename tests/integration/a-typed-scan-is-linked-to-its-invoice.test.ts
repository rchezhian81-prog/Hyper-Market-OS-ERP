import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **D03-FR-02 (round 12 follow-up) — a scan typed on the capture screen is linked to the invoice it became.**
 *
 * With no OCR engine connected, a scan waits as `awaiting_manual_capture` and a person types the bill through the typed
 * capture (`POST /v1/purchase/invoices/:id/capture`). That capture now NAMES the scan (`documentId`, optional) and head
 * office records an append-only "typed as invoice X" event on the document; the document list then reads the scan as
 * `captured` with its invoice and who typed it. No new money rule: the invoice is captured exactly as before.
 *
 * Real routes through the real pipeline, in memory and — with DATABASE_URL — on real PostgreSQL:
 *   • the link: 201 with the documentId; the list shows the scan `captured`, invoiceId, typedBy; `waiting` drops;
 *   • refusals by name, each with NOTHING recorded (no invoice, no link): an unknown document (404
 *     `invoice_document_unknown`), another tenant's scan (404 — it is not this tenant's), an e-invoice draft (409
 *     `not_a_scan_awaiting_typing`), a scan already typed as ANOTHER invoice (409 `scan_already_typed`), a role without the
 *     capture right (403);
 *   • replay: the same request again is answered once; a re-send under a fresh key is `alreadyCaptured`; exactly ONE link
 *     event is in the ledger;
 *   • a race: two captures of different invoices naming the same scan at once — one stands, the other is refused by name and
 *     its invoice is not kept (hard rule #10);
 *   • a typed scan cannot then be "confirmed" as a read draft; a capture naming no scan behaves exactly as before;
 *   • round 13 (verifier B3, probe P1 · P-08): the link and the invoice are ONE atomic write. A crash as the invoice is
 *     written, and a failure INSIDE the write (the invoice's id already held — the batch is rolled back in the store's own
 *     transaction), each leave NO "captured" without an invoice: the scan still waits, nothing is on the register, and
 *     the same scan typed again (the same number after a crash, a corrected number after a clash) links and captures.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; make: () => { store: EventStore; opts: Parameters<typeof apiHarness>[0] } }[] = [
  { name: 'the in-memory event store', make: () => { const store = new InMemoryEventStore(); return { store, opts: { store } }; } },
];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', make: () => { const sql = pgPoolClient(pool!); const store = new SqlEventStore(sql); return { store, opts: { store, idempotency: new SqlIdempotencyStore(sql) } }; } });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const GSTIN = '33ABCDE1234F1Z5';
const eInvoice = {
  Version: '1.1', Irn: `irn-${'b'.repeat(60)}`,
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
  DocDtls: { Typ: 'INV', No: 'KA/9', Dt: '05/10/2026' },
  SellerDtls: { Gstin: GSTIN, LglNm: 'Synthetic supplier', Addr1: 'Synthetic street', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  BuyerDtls: { Gstin: '33ZZZZZ9999Z1Z9', LglNm: 'Synthetic store', Pos: '33', Addr1: 'Synthetic road', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  ItemList: [{ SlNo: '1', PrdDesc: 'Rice', IsServc: 'N', HsnCd: '1006', Barcde: 'K-RICE', Qty: 10, Unit: 'NOS', UnitPrice: 50, TotAmt: 500, AssAmt: 500, GstRt: 0, CgstAmt: 0, SgstAmt: 0, IgstAmt: 0, TotItemVal: 500 }],
  ValDtls: { AssVal: 500, CgstVal: 0, SgstVal: 0, IgstVal: 0, TotInvVal: 500 },
};
const scanBody = (text: string) => ({ kind: 'scan', mediaType: 'image/png', contentBase64: Buffer.from(`synthetic paper bill ${text}`, 'utf8').toString('base64') });
const typed = (documentId?: string) => ({
  supplierId: 'sup-k', declaredTotalMinor: 50_000, lines: [{ productId: 'RICE', quantity: 10, unitPriceMinor: 5_000, lineTotalMinor: 50_000 }],
  ...(documentId === undefined ? {} : { documentId }),
});
interface Doc { documentId: string; state: string; invoiceId?: string; typedBy?: string; typedAt?: string }

describe.each(backings)('a typed scan is linked to the invoice it became — on $name (D03-FR-02)', ({ make }) => {
  const setup = async () => {
    const { store, opts } = make();
    const h = apiHarness(opts);
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await h.provisionRole(T, 'u-buyer2', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, tenantId = T): Promise<Res> =>
      h.request({ method, path, userId, tenantId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }) });
    const docs = async (): Promise<{ documents: Doc[]; waiting: number }> => (await call('GET', '/v1/purchase/invoice-documents', 'u-owner')).body as { documents: Doc[]; waiting: number };
    const onRegister = async (invoiceId: string) => (await call('GET', `/v1/purchase/invoices/${invoiceId}`, 'u-owner')).status === 200;
    const linkEvents = async () => (await store.exportTenant(T)).filter((r) => r.event.type === 'InvoiceDocumentTyped');
    return { h, T, call, docs, onRegister, linkEvents };
  };

  it('links the scan, refuses every wrong link by name with nothing kept, and collapses a re-send', async () => {
    const { h, call, docs, onRegister, linkEvents } = await setup();
    expect((await call('POST', '/v1/purchase/invoice-documents/scan-1', 'u-buyer', scanBody('one'))).status).toBe(201);
    expect((await call('POST', '/v1/purchase/invoice-documents/einv-1', 'u-buyer', { kind: 'e_invoice', eInvoice })).status).toBe(201);
    let l = await docs();
    expect(l.documents.find((d) => d.documentId === 'scan-1')?.state).toBe('awaiting_manual_capture');
    expect(l.waiting).toBe(2);

    // ── Refusals: each names the reason; no invoice and no link is kept ──────────────────────────────────────────
    const unknown = await call('POST', '/v1/purchase/invoices/inv-x/capture', 'u-buyer', typed('no-such-doc'));
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'invoice_document_unknown']);
    const notScan = await call('POST', '/v1/purchase/invoices/inv-x/capture', 'u-buyer', typed('einv-1'));
    expect([notScan.status, codeOf(notScan)]).toEqual([409, 'not_a_scan_awaiting_typing']);
    expect((notScan.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/an e-invoice that is draft/);
    const noRight = await call('POST', '/v1/purchase/invoices/inv-x/capture', 'u-till', typed('scan-1'));
    expect(noRight.status).toBe(403);
    // Another tenant cannot link (or even see) this tenant's scan.
    const U = randomUUID();
    await h.seedOwner(U, 'u-owner-b');
    const foreign = await call('POST', '/v1/purchase/invoices/inv-x/capture', 'u-owner-b', typed('scan-1'), undefined, U);
    expect([foreign.status, codeOf(foreign)]).toEqual([404, 'invoice_document_unknown']);
    expect(await onRegister('inv-x')).toBe(false);
    expect(await linkEvents()).toHaveLength(0);

    // ── The link ────────────────────────────────────────────────────────────────────────────────────────────────
    const first = await call('POST', '/v1/purchase/invoices/inv-1/capture', 'u-buyer', typed('scan-1'), 'cap-1');
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ documentId: 'scan-1', invoice: { invoiceId: 'inv-1', totalMinor: 50_000, capturedBy: 'u-buyer', source: 'head-office' }, alreadyCaptured: false });
    l = await docs();
    expect(l.documents.find((d) => d.documentId === 'scan-1')).toMatchObject({ state: 'captured', invoiceId: 'inv-1', typedBy: 'u-buyer' });
    expect(l.waiting).toBe(1); // only the e-invoice draft still waits
    expect((await call('GET', '/v1/purchase/invoice-documents/scan-1', 'u-buyer')).body).toMatchObject({ document: { state: 'captured', invoiceId: 'inv-1' } });

    // ── Replay: the same request, then a re-send under a fresh key — one invoice, ONE link ────────────────────────
    expect((await call('POST', '/v1/purchase/invoices/inv-1/capture', 'u-buyer', typed('scan-1'), 'cap-1')).status).toBe(201);
    const resend = await call('POST', '/v1/purchase/invoices/inv-1/capture', 'u-buyer', typed('scan-1'));
    expect(resend).toMatchObject({ status: 200, body: { alreadyCaptured: true, documentId: 'scan-1' } });
    const links = await linkEvents();
    expect(links).toHaveLength(1);
    expect(links[0]!.event.payload).toMatchObject({ documentId: 'scan-1', invoiceId: 'inv-1', typedBy: 'u-buyer' });

    // ── The same scan for ANOTHER invoice: refused by name; that invoice is not kept ─────────────────────────────
    const twice = await call('POST', '/v1/purchase/invoices/inv-2/capture', 'u-buyer2', typed('scan-1'));
    expect([twice.status, codeOf(twice)]).toEqual([409, 'scan_already_typed']);
    expect((twice.body as { error: { whatHappened: string } }).error.whatHappened).toBe('Scan scan-1 was already typed as invoice inv-1. One scan is one bill.');
    expect(await onRegister('inv-2')).toBe(false);
    expect(await linkEvents()).toHaveLength(1);

    // A typed scan is not a read draft: confirming it is refused by name.
    const confirm = await call('POST', '/v1/purchase/invoice-documents/scan-1/confirm', 'u-buyer', { invoiceId: 'inv-9', lines: [] });
    expect([confirm.status, codeOf(confirm)]).toEqual([409, 'nothing_read_to_confirm']);

    // A capture naming no scan behaves as it always did — and links nothing.
    expect((await call('POST', '/v1/purchase/invoices/inv-plain/capture', 'u-buyer', typed())).status).toBe(201);
    expect(await linkEvents()).toHaveLength(1);
  }, 60_000);

  it('two captures of DIFFERENT invoices naming the same scan at once: one stands, the other is refused and not kept', async () => {
    const { call, docs, onRegister, linkEvents } = await setup();
    for (let i = 0; i < 4; i += 1) {
      const scanId = `scan-race-${i}`;
      expect((await call('POST', `/v1/purchase/invoice-documents/${scanId}`, 'u-buyer', scanBody(scanId))).status).toBe(201);
      const [a, b] = await Promise.all([
        call('POST', `/v1/purchase/invoices/inv-a-${i}/capture`, 'u-buyer', typed(scanId)),
        call('POST', `/v1/purchase/invoices/inv-b-${i}/capture`, 'u-buyer2', typed(scanId)),
      ]);
      expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(codeOf(loser)).toBe('scan_already_typed');
      const winnerId = a.status === 201 ? `inv-a-${i}` : `inv-b-${i}`;
      const loserId = a.status === 201 ? `inv-b-${i}` : `inv-a-${i}`;
      expect(await onRegister(winnerId)).toBe(true);
      expect(await onRegister(loserId)).toBe(false);
      expect((await docs()).documents.find((d) => d.documentId === scanId)).toMatchObject({ state: 'captured', invoiceId: winnerId });
    }
    expect(await linkEvents()).toHaveLength(4);
  }, 60_000);

  it('round 13 (P1): a failure as the invoice is written leaves the scan waiting — never "captured" as an invoice that does not exist', async () => {
    const { store, opts } = make();
    // A simulated crash: the first write carrying the invoice dies before it reaches the store.
    let crash = true;
    const crashing = new Proxy(store, {
      get(t, p, r) {
        if (p === 'append' || p === 'appendBatch') {
          return async (tenantId: string, ...rest: unknown[]) => {
            const events = p === 'append' ? [rest[1] as { type: string }] : (rest[0] as { event: { type: string } }[]).map((e) => e.event);
            if (crash && events.some((e) => e.type === 'SupplierInvoiceCaptured')) { crash = false; throw new Error('simulated crash as the invoice is written'); }
            return (t[p] as (...a: unknown[]) => unknown).call(t, tenantId, ...rest);
          };
        }
        const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as EventStore;
    const h = apiHarness({ ...opts, store: crashing });
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }) });
    const docs = async () => (await call('GET', '/v1/purchase/invoice-documents', 'u-owner')).body as { documents: Doc[]; waiting: number };
    const onRegister = async (invoiceId: string) => (await call('GET', `/v1/purchase/invoices/${invoiceId}`, 'u-owner')).status === 200;
    const linkEvents = async () => (await store.exportTenant(T)).filter((r) => r.event.type === 'InvoiceDocumentTyped');

    // ── 1. A crash as the invoice is written.
    expect((await call('POST', '/v1/purchase/invoice-documents/scan-1', 'u-buyer', scanBody('crash'))).status).toBe(201);
    const crashed = await call('POST', '/v1/purchase/invoices/inv-1/capture', 'u-buyer', typed('scan-1'), 'cap-crash');
    expect(crashed.status).toBe(500);
    expect((await docs()).documents.find((d) => d.documentId === 'scan-1')).toMatchObject({ state: 'awaiting_manual_capture' });
    expect((await docs()).waiting).toBe(1);
    expect(await onRegister('inv-1')).toBe(false);
    expect(await linkEvents()).toHaveLength(0);
    // The same capture sent again (a fresh key after the failure) links and captures, once.
    const again = await call('POST', '/v1/purchase/invoices/inv-1/capture', 'u-buyer', typed('scan-1'));
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await docs()).documents.find((d) => d.documentId === 'scan-1')).toMatchObject({ state: 'captured', invoiceId: 'inv-1' });
    expect(await onRegister('inv-1')).toBe(true);

    // ── 2. A failure INSIDE the write: the invoice's id is already held by another record, so the store refuses the
    //       invoice after the link was staged — the whole batch is rolled back (on PostgreSQL, in its own transaction).
    expect((await call('POST', '/v1/purchase/invoice-documents/scan-2', 'u-buyer', scanBody('clash'))).status).toBe(201);
    await store.append(T, 'test-clash', makeEvent({ id: 'invoice-inv-2', type: 'UnrelatedRecord', occurredAt: '2026-10-07T00:00:00.000Z', idempotencyKey: `unrelated-${T}`, source: 'test', payload: {} }));
    const clashed = await call('POST', '/v1/purchase/invoices/inv-2/capture', 'u-buyer', typed('scan-2'));
    expect(clashed.status, JSON.stringify(clashed.body)).toBeGreaterThanOrEqual(400);
    expect((await docs()).documents.find((d) => d.documentId === 'scan-2')).toMatchObject({ state: 'awaiting_manual_capture' });
    expect(await onRegister('inv-2')).toBe(false);
    expect((await linkEvents()).map((r) => (r.event.payload as { documentId: string }).documentId)).toEqual(['scan-1']);
    // Typed again under a corrected invoice number: the scan is not held by a phantom link, so it links and captures.
    const corrected = await call('POST', '/v1/purchase/invoices/inv-2b/capture', 'u-buyer', typed('scan-2'));
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect((await docs()).documents.find((d) => d.documentId === 'scan-2')).toMatchObject({ state: 'captured', invoiceId: 'inv-2b' });
    expect(await onRegister('inv-2b')).toBe(true);
    expect((await docs()).waiting).toBe(0);
  }, 60_000);
});
