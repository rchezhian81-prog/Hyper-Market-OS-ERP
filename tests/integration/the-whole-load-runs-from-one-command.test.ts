import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { aStoreWithRules } from '../support/store-rules';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { sealExtract, simpleHasher, type SealedExtract } from '../../packages/migration/src/index';
import { runFullLoadCommand, type FullLoadCommandInput } from '../../packages/migration/src/load-command-phases';

/**
 * **GT-05 — the whole opening runs from the operator's ONE load command (MG-05 · MG-06 · MG-07 · MG-08 · §28 · P-08).**
 *
 * One sealed folder — master data, opening stock across three locations with batches, history with its document files and
 * the old system's per-kind report, the open purchase orders, and the old trial balance — goes through the operator's command
 * (`runFullLoadCommand`, what `pnpm run migration:load` runs), in process, on the in-memory store and on REAL PostgreSQL:
 *
 *   run 1  master data and opening stock land and read back; history lands and reconciles; the trial balance is RECORDED and
 *          waits for a second finance person; the open orders are refused BY NAME (their suppliers are not yet approved by
 *          finance, OB-32) — exit 1, NOT FINISHED, every wait named;
 *   run 2  (finance approved the suppliers) the orders are raised and wait for a second person to issue them — exit 1;
 *   run 3  (the owner issued them on their own screen; the accountant signed the trial balance) what already came is carried,
 *          every order reads back, the ledger agrees with the old trial balance — exit 0, FINISHED;
 *   run 4  the same command again doubles nothing: stock, the carried receipts, history and the opening journal are as they were.
 * The command never signs and never issues: the second people act in their own sessions.
 */

const OPERATOR = 'u-loader';
const ACCOUNTANT = 'u-acct';
const APPROVER = 'u-owner2';
const STORE = 'S1';
const LOAD = 'load-2026-10-10';

const pdfB64 = (text: string): string => Buffer.from(`%PDF-1.4\n% synthetic legacy scan\n${text}\n%%EOF\n`, 'utf8').toString('base64');
const shaOf = (b64: string): string => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
const SCANS = { 'scan-1.pdf': pdfB64('invoice SI-1000'), 'scan-2.pdf': pdfB64('bill PI-77') };

const FILES: Record<string, string> = {
  'categories.csv': ['category_id,name,parent_id', 'home,Home care,'].join('\n'),
  'tax-rates.csv': ['hsn_code,effective_from,rate_percent', '3402,2017-07-01,18'].join('\n'),
  'products.csv': [
    'item_code,description,uom,category,hsn,mrp,selling_price,cost_price,barcodes,status',
    ...[1, 2, 3, 4, 5, 6].map((i) => `P-000${i},Synthetic item ${i},each,home,3402,${25 + i}.00,${20 + i}.00,${15 + i}.00,INT-000${i},active`),
  ].join('\n'),
  'suppliers.csv': ['supplier_code,supplier_name', 'SUP-1,Synthetic Traders 1', 'SUP-2,Synthetic Traders 2'].join('\n'),
  'customers.csv': ['customer_code,loyalty_points', 'C-0001,120', 'C-0002,'].join('\n'),
  // Three locations; batch-tracked lines carry their expiry.
  'opening-stock.csv': [
    'item_code,location,qty,uom,cost,batch,expiry',
    'P-0001,S1,40,each,16.00,B1-A,2027-06-30', 'P-0001,S1,12,each,16.00,B1-B,2027-09-30', 'P-0001,S1-BACK,80,each,16.00,B1-A,2027-06-30',
    'P-0002,,25,each,17.00,,', 'P-0002,WH-1,100,each,17.00,,', 'P-0003,S1-BACK,30,each,18.00,,', 'P-0004,,10,each,19.00,,',
    'P-0005,WH-1,60,each,20.00,,', 'P-0006,S1,5,each,21.00,,',
  ].join('\n'),
  'history.csv': [
    'kind,legacy_id,number,date,party,net,tax,gross,attachments',
    'sales_invoice,SI-1000,SRE/24-25/1000,2025-01-15,C-0001,100.00,18.00,118.00,DOC-1',
    'sales_invoice,SI-1001,SRE/24-25/1001,2025-02-15,C-0002,50.00,9.00,59.00,',
    'goods_receipt,GRN-77,GRN/77,2025-03-01,SUP-1,640.00,0.00,640.00,',
    'purchase_invoice,PI-77,BILL-77,2025-03-02,SUP-1,640.00,115.20,755.20,DOC-2',
  ].join('\n'),
  'history-lines.csv': [
    'kind,legacy_id,item_code,qty,net,tax',
    'sales_invoice,SI-1000,P-0001,2,60.00,10.80', 'sales_invoice,SI-1000,P-0002,1,40.00,7.20',
  ].join('\n'),
  'history-control-totals.csv': [
    'kind,count,gross,tax', 'sales_invoice,2,177.00,27.00', 'goods_receipt,1,640.00,0.00', 'purchase_invoice,1,755.20,115.20',
  ].join('\n'),
  'attachments.csv': [
    'legacy_id,file_name,content_type,sha256',
    `DOC-1,scan-1.pdf,application/pdf,${shaOf(SCANS['scan-1.pdf'])}`, `DOC-2,scan-2.pdf,application/pdf,${shaOf(SCANS['scan-2.pdf'])}`,
  ].join('\n'),
  'open-orders.csv': [
    'po_id,number,supplier,deliver_to,item_code,ordered,received,unit_cost',
    'LPO-501,PO/24-25/501,SUP-1,S1,P-0001,100,30,15.00', 'LPO-501,PO/24-25/501,SUP-1,S1,P-0002,50,0,16.00',
    'LPO-502,PO/24-25/502,SUP-2,S1,P-0003,24,0,17.00',
  ].join('\n'),
  'trial-balance.csv': [
    'account_code,account_name,debit,credit',
    'inventory,Stock in trade,50000.00,', 'bank,Bank — current account,20000.00,', 'cash_in_hand,Cash in hand,1500.00,',
    'supplier_payable,Sundry creditors,,9000.00', 'gst_output_payable,GST output payable,,1000.00', 'capital,Proprietor\'s capital,,61500.00',
  ].join('\n'),
  'trial-balance-totals.csv': ['total_debit,total_credit,account_count', '71500.00,71500.00,6'].join('\n'),
};

const dataRows = (text: string): number => text.split('\n').length - 1;
const seal = (t: string, name: string, text: string): SealedExtract => {
  const r = sealExtract({ extractId: `x-${name}`, tenantId: t, sourceId: 'legacy-erp', material: text, rowCount: dataRows(text), extractedBy: OPERATOR, backupVerifiedAt: '2026-10-09T20:00:00.000Z', hasher: simpleHasher, now: '2026-10-09T21:00:00.000Z' });
  if (!r.ok || r.extract === undefined) throw new Error(r.detail);
  return r.extract;
};
const input = (h: ApiHarness, t: string, dryRun = false): FullLoadCommandInput => ({
  manifest: {
    loadId: LOAD, tenantId: t, operator: OPERATOR, stockLocationId: STORE, receivedOnDate: '2026-10-10',
    files: Object.fromEntries(Object.entries(FILES).map(([name, text]) => [name, { seal: seal(t, name, text), declaredRows: dataRows(text) }])),
  },
  files: FILES, exceptions: { exceptions: [] }, targetKind: 'rehearsal', demoTenantIds: [], dryRun, client: h, attachmentBytes: SCANS,
});

let pool: Pool | undefined;
const DATABASE_URL = process.env['DATABASE_URL'];
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
interface Backing { readonly store: EventStore; readonly idempotency: MemoryIdempotencyStore | SqlIdempotencyStore }
const backings: { name: string; backing: () => Backing }[] = [
  { name: 'the in-memory event store', backing: () => ({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore() }) },
];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', backing: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });

/** What the shop holds, for "nothing doubled": stock per place, the orders' received quantities, history, the opening journal. */
async function holdings(h: ApiHarness, t: string): Promise<string> {
  const get = async (path: string, query?: Record<string, string>) => (await h.request({ method: 'GET', path, userId: OPERATOR, tenantId: t, ...(query === undefined ? {} : { query }) })).body;
  const avail = ((await get('/v1/inventory/availability')) as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows.map((r) => `${r.productId}@${r.locationId}=${r.onHandMinor}`).sort();
  const po = ((await get('/v1/purchase/orders/LPO-501')) as { order: { receivedByProduct: unknown } }).order.receivedByProduct;
  const hist = ((await get('/v1/migration/history/documents')) as { documents: unknown[] }).documents.length;
  const ledger = ((await get(`/v1/finance/account-openings/${LOAD}`)) as { ledger: unknown }).ledger;
  const journals = (await h.store.readStream(t, 'finance', { type: 'JournalPosted' })).length;
  return JSON.stringify({ avail, po, hist, ledger, journals });
}

describe.each(backings)('GT-05 the whole load runs from one command — on $name', ({ backing }) => {
  it('master, opening stock, history, open orders and the trial balance — every wait named, finished only when all reconcile, and a re-run doubles nothing', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await h.seedOwner(t, OPERATOR);
    await aStoreWithRules(h, t, OPERATOR, STORE, 0);
    await h.provisionRole(t, ACCOUNTANT, 'accountant');
    await h.provisionRole(t, APPROVER, 'owner');
    const as = (userId: string, path: string, body: unknown) => h.request({ method: 'POST', path, userId, tenantId: t, idempotencyKey: `${userId}-${path}`, body });

    // A dry run plans every phase and sends nothing.
    const dry = await runFullLoadCommand(input(h, t, true));
    expect(dry.exitCode).toBe(0);
    expect(dry.lines.join('\n')).toMatch(/Phase plan — accounting openings: 6 ledger account/);
    expect(dry.lines.join('\n')).toMatch(/Phase plan — history: 4 document\(s\), 2 attachment/);
    expect(dry.lines.join('\n')).toMatch(/Phase plan — open orders: 2 order/);

    // Run 1: suppliers are not yet approved by finance — the orders are refused by name; the trial balance waits.
    const run1 = await runFullLoadCommand(input(h, t));
    const text1 = run1.lines.join('\n');
    expect(run1.exitCode).toBe(1);
    expect(text1).toContain('Opening state read back');
    expect(text1).toMatch(/every one agrees with the sealed extract/);
    expect(text1).toMatch(/History: 6 record\(s\) landed; every document, attachment and per-kind total agrees/);
    expect(text1).toMatch(/✗ open order LPO-501 — propose/);
    expect(text1).toMatch(/Accounting openings: the trial balance \(6 accounts\) is RECORDED, not yet the books\. WAITING/);
    expect(text1).toContain('NOT FINISHED');
    expect(run1.phases?.find((p) => p.phase === 'history')).toMatchObject({ landed: true, reconciled: true });

    // Finance approves the migrated suppliers. Run 2: the orders are raised and wait for a second person.
    for (const s of ['SUP-1', 'SUP-2']) expect((await as(ACCOUNTANT, `/v1/purchase/suppliers/${s}/approval`, { reason: 'migrated supplier, documents checked' })).status).toBeLessThan(300);
    const run2 = await runFullLoadCommand(input(h, t));
    expect(run2.exitCode).toBe(1);
    expect(run2.lines.join('\n')).toMatch(/WAITING — 2 raised and awaiting a second person's approval .*LPO-501, LPO-502/);
    expect(run2.phases?.find((p) => p.phase === 'open_orders')?.waiting).toHaveLength(1);

    // The owner issues the orders on their own screen; the accountant signs the trial balance off against the printed totals.
    for (const po of ['LPO-501', 'LPO-502']) expect((await as(APPROVER, `/v1/purchase/orders/${po}/approval`, { reason: 'open on the old system at cutover' })).status).toBe(200);
    expect((await as(ACCOUNTANT, `/v1/finance/account-openings/${LOAD}/sign-off`, { oldSystemDebitMinor: 7_150_000, oldSystemCreditMinor: 7_150_000, accountCount: 6 })).status).toBe(201);

    // Run 3: carried, read back, reconciled — FINISHED.
    const run3 = await runFullLoadCommand(input(h, t));
    const text3 = run3.lines.join('\n');
    expect(text3).toMatch(/Accounting openings: signed, posted, and the ledger agrees with the old trial balance account by account \(6 accounts\)/);
    expect(text3).toMatch(/Open orders: 2 issued, with what already came carried; every order and the stores' open deliveries agree/);
    expect(text3).toContain('FINISHED');
    expect(run3.exitCode).toBe(0);
    const po501 = (await h.request({ method: 'GET', path: '/v1/purchase/orders/LPO-501', userId: OPERATOR, tenantId: t })).body as { order: { status: string; approvedBy: string; receivedByProduct: Record<string, number> } };
    expect(po501.order).toMatchObject({ status: 'issued', approvedBy: APPROVER, receivedByProduct: { 'P-0001': 30 } });
    const before = await holdings(h, t);

    // Run 4: the same command again — nothing doubles.
    const run4 = await runFullLoadCommand(input(h, t));
    expect(run4.exitCode).toBe(0);
    expect(await holdings(h, t)).toBe(before);
    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: t })).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] };
    expect(avail.rows.filter((r) => r.productId === 'P-0001').map((r) => [r.locationId, r.onHandMinor]).sort()).toEqual([['S1', 52], ['S1-BACK', 80]]);
  }, 240_000);

  it('a phase file that cannot be read is refused by name — the trial balance whose totals are missing, an attachment not in the folder', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await h.seedOwner(t, OPERATOR);
    await aStoreWithRules(h, t, OPERATOR, STORE, 0);
    const files = { ...FILES };
    delete files['trial-balance-totals.csv'];
    const base = input(h, t, true);
    const out = await runFullLoadCommand({ ...base, files, manifest: { ...(base.manifest as Record<string, unknown>), files: Object.fromEntries(Object.entries((base.manifest as { files: Record<string, unknown> }).files).filter(([k]) => k !== 'trial-balance-totals.csv')) }, attachmentBytes: { 'scan-1.pdf': SCANS['scan-1.pdf'] } });
    expect(out.exitCode).toBe(1);
    const text = out.lines.join('\n');
    expect(text).toMatch(/trial-balance-totals\.csv must hold ONE row/);
    expect(text).toMatch(/attachments\.csv line 3: the file scan-2\.pdf is not in the attachments folder/);
  }, 120_000);
});
