import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId } from '../support/approval-request';
import { seedImportTargets } from '../support/invoice-import';
import { aStoreWithRules } from '../support/store-rules';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **OB-315 (owner, 23 Oct 2026, in writing — "import all domains") · M30-FR-01/03/04.**
 *
 * Suppliers, store price lists, opening stock, customers and opening loyalty balances load through the real import
 * pipeline (in memory, and on PostgreSQL across a cold restart). For each:
 *   • a DRY RUN keeps every row-by-row exception, by the named person who ran it, and applies nothing; the same file is
 *     refused at commit while any exception remains — never a partial load;
 *   • a clean file commits only with a second person's approval, and writes the domain's OWN records (the supplier
 *     master, the store's price list, the stock ledger, the loyalty register and points ledger);
 *   • an opening stock or opening points balance is the FIRST fact — a second opening for the same place or member is an
 *     exception, never an overwrite;
 *   • a customer's mobile number is never kept on the job's record or the dry run (the member code and last four only);
 *   • a ROLLBACK is compensating records, approved by a second person, and refused by name while anything has used what
 *     the load wrote.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const csv = (header: readonly string[], rows: readonly (readonly (string | number)[])[]): string => [header.join(','), ...rows.map((r) => r.join(','))].join('\n');

const post = (h: ApiHarness, T: string, userId: string, path: string, body: unknown) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
const get = (h: ApiHarness, T: string, userId: string, path: string, query?: Record<string, string>) => h.request({ method: 'GET', path, userId, tenantId: T, ...(query === undefined ? {} : { query }) });

async function dryRun(h: ApiHarness, T: string, runId: string, templateId: string, text: string) {
  const r = await post(h, T, MGR, `/v1/import/dry-runs/${runId}`, { templateId, text });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { dryRun: { errorRowCount: number; errors: { line: number; column: string; message: string }[]; ranBy: string; commitReady: boolean } }).dryRun;
}

/** Maker (the manager) validates, asks; the owner approves in his own session; the maker commits naming the approval. */
async function commit(h: ApiHarness, T: string, jobId: string, templateId: string, text: string): Promise<Res> {
  const v = await post(h, T, MGR, '/v1/import/validate', { templateId, text });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  const contentFingerprint = (v.body as { contentFingerprint: string }).contentFingerprint;
  const approvalId = await approvedRequestId(h, T, MGR, OWNER, { kind: 'data_import_commit', subjectRef: jobId, details: { jobId, contentFingerprint } });
  return post(h, T, MGR, '/v1/import/commit', { jobId, templateId, text, approvalId });
}
async function rollback(h: ApiHarness, T: string, jobId: string): Promise<Res> {
  const approvalId = await approvedRequestId(h, T, MGR, OWNER, { kind: 'data_import_rollback', subjectRef: jobId, details: { jobId } });
  return post(h, T, MGR, `/v1/import/commits/${jobId}/rollback`, { reason: 'synthetic: loaded against the wrong file', approvalId });
}
const committed = (r: Res) => { expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body as { effects: { kind: string; ref: string }[] }; };

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager');
  await h.provisionRole(T, CASHIER, 'cashier');
  await seedImportTargets(h, T); // products P1–P5 (each in "ea"), supplier S-1
  await aStoreWithRules(h, T, OWNER, 'S1', 2_000); // the store, with a 20% margin floor
}

async function suppliers(h: ApiHarness, T: string): Promise<void> {
  const header = ['supplierId', 'name', 'gstin', 'phone', 'email', 'address', 'paymentTermsDays'];
  const bad = csv(header, [['SUP-1', 'Amma Traders', '33AAAAA0000A1Z9', '', '', '', 30], ['S-1', 'Synthetic Wholesale', '', '', '', '', ''], ['SUP-2', 'Kavi Foods', 'BAD', '', '', '', 'x']]);
  const d = await dryRun(h, T, 'dr-sup-1', 'supplier-v1', bad);
  expect(d.ranBy).toBe(MGR);
  expect(d.commitReady).toBe(false);
  expect(d.errors.map((e) => `${e.line}:${e.column}`).sort()).toEqual(['3:supplierId', '4:gstin', '4:paymentTermsDays']);
  // The same file is refused WHOLE at commit while any row is wrong.
  expect(codeOf(await commit(h, T, 'J-SUP-BAD', 'supplier-v1', bad))).toBe('import_refused_has_errors');
  const good = csv(header, [['SUP-1', 'Amma Traders', '33AAAAA0000A1Z9', '9000000001', '', 'Madurai', 30], ['SUP-2', 'Kavi Foods', '33ZZZZZ9999Z1ZF', '', '', '', '']]);
  expect(committed(await commit(h, T, 'J-SUP', 'supplier-v1', good)).effects.map((e) => e.ref)).toEqual(['SUP-1', 'SUP-2']);
  const sup = (await get(h, T, OWNER, '/v1/purchase/suppliers/SUP-1')).body as { supplier: { status: string; createdBy: string; gstin: string }; blocked: boolean };
  expect(sup.supplier).toMatchObject({ status: 'proposed', createdBy: MGR, gstin: '33AAAAA0000A1Z9' });
  expect(sup.blocked).toBe(false);
  // Undone: blocked with the reason, kept on the master as evidence.
  expect((await rollback(h, T, 'J-SUP')).status).toBe(200);
  expect(((await get(h, T, OWNER, '/v1/purchase/suppliers/SUP-1')).body as { blocked: boolean }).blocked).toBe(true);
  expect(codeOf(await rollback(h, T, 'J-SUP'))).toBe('import_already_rolled_back');
}

async function prices(h: ApiHarness, T: string): Promise<void> {
  const header = ['productId', 'storeId', 'priceMinor', 'mrpMinor', 'costMinor'];
  const bad = csv(header, [['P1', 'S1', 12_000, 15_000, 9_000], ['P2', 'S1', 20_000, 15_000, 9_000], ['P3', 'S1', 9_500, 15_000, 9_000], ['P4', 'NOWHERE', 12_000, 15_000, 9_000]]);
  const d = await dryRun(h, T, 'dr-price-1', 'price-list-v1', bad);
  expect(d.errors.map((e) => `${e.line}:${e.column}`).sort()).toEqual(['3:priceMinor', '4:priceMinor', '5:storeId']);
  expect(d.errors.find((e) => e.line === 3)!.message).toContain('above the MRP');
  expect(d.errors.find((e) => e.line === 4)!.message).toContain('margin floor');
  committed(await commit(h, T, 'J-PRICE', 'price-list-v1', csv(header, [['P1', 'S1', 12_000, 15_000, 9_000], ['P4', 'S1', 13_000, 15_000, 9_000]])));
  committed(await commit(h, T, 'J-PRICE-2', 'price-list-v1', csv(header, [['P1', 'S1', 12_500, 15_000, 9_000]])));
  const priceOf = async (productId: string): Promise<{ priceMinor: string; status: string; entryId: string }[]> => {
    const r = await post(h, T, OWNER, '/v1/export/price-lists', {});
    const rows = (r.body as { csv: string }).csv.trim().split('\n').map((l) => l.split(','));
    const head = rows[0]!; const col = (row: string[], n: string): string => row[head.indexOf(n)]!;
    return rows.slice(1).filter((x) => col(x, 'productId') === productId && col(x, 'store') === 'S1').map((x) => ({ priceMinor: col(x, 'priceMinor'), status: col(x, 'status'), entryId: col(x, 'entryId') }));
  };
  expect((await priceOf('P1')).map((x) => x.priceMinor)).toEqual(['12000', '12500']);
  // The older load cannot be undone — its price was changed again since; nor can one that would leave no price at all.
  expect(codeOf(await rollback(h, T, 'J-PRICE'))).toBe('import_effect_in_use');
  // The newer one is undone: the price it replaced comes back as a NEW version (nothing overwritten).
  expect((await rollback(h, T, 'J-PRICE-2')).status).toBe(200);
  expect((await priceOf('P1')).map((x) => x.priceMinor)).toEqual(['12000', '12500', '12000']);
}

async function openingStock(h: ApiHarness, T: string): Promise<void> {
  const header = ['productId', 'locationId', 'quantity', 'unitCostMinor', 'batchId', 'expiry'];
  const at = new Date().toISOString();
  expect((await post(h, T, OWNER, '/v1/inventory/movements', { movementId: 'mv-p3', productId: 'P3', locationId: 'S1', kind: 'received', quantityMinor: 5, uom: 'ea', occurredAt: at, enteredBy: OWNER, unitCostMinor: 100 })).status).toBeLessThan(300);
  const bad = csv(header, [['P1', 'S1', 100, 9_000, '', ''], ['P3', 'S1', 10, 100, '', ''], ['P5', 'S1', 10, 500, 'B-1', ''], ['P2', 'NOWHERE', 1, 100, '', ''], ['P4', 'S1', 0, 100, '', '']]);
  const d = await dryRun(h, T, 'dr-stock-1', 'opening-stock-v1', bad);
  expect(d.errors.map((e) => `${e.line}:${e.column}`).sort()).toEqual(['3:productId', '4:expiry', '5:locationId', '6:quantity']);
  expect(d.errors.find((e) => e.line === 3)!.message).toContain('never by an opening');
  committed(await commit(h, T, 'J-STOCK', 'opening-stock-v1', csv(header, [['P1', 'S1', 100, 9_000, '', ''], ['P4', 'S1', 20, 500, 'B-9', '2027-01-31']])));
  const onHand = async (p: string): Promise<number | undefined> => ((await get(h, T, OWNER, '/v1/inventory/availability')).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows.find((r) => r.productId === p && r.locationId === 'S1')?.onHandMinor;
  expect(await onHand('P1')).toBe(100);
  expect(await onHand('P4')).toBe(20);
  // A second opening for the same product and place is an exception — never an overwrite.
  const again = await dryRun(h, T, 'dr-stock-2', 'opening-stock-v1', csv(header, [['P1', 'S1', 90, 9_000, '', '']]));
  expect(again.errors[0]!.message).toContain('never by an opening');
  // Once something has moved, the opening is not undone (corrected by a count).
  committed(await commit(h, T, 'J-STOCK-2', 'opening-stock-v1', csv(header, [['P5', 'S1', 10, 500, '', '']])));
  expect((await post(h, T, OWNER, '/v1/inventory/movements', { movementId: 'mv-p5-more', productId: 'P5', locationId: 'S1', kind: 'received', quantityMinor: 4, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER, unitCostMinor: 500 })).status).toBeLessThan(300);
  expect(codeOf(await rollback(h, T, 'J-STOCK-2'))).toBe('import_effect_in_use');
  // The clean one is undone by an opening-reversed movement: back to nothing at that place.
  expect((await rollback(h, T, 'J-STOCK')).status).toBe(200);
  expect(await onHand('P1') ?? 0).toBe(0);
}

async function customersAndPoints(h: ApiHarness, T: string): Promise<void> {
  const header = ['mobile', 'loyaltyConsent', 'consentGivenOn', 'consentEvidence', 'name'];
  const bad = csv(header, [['9876543210', 'yes', '2025-04-01', 'paper form', 'Lakshmi R'], ['9876543211', 'no', '2025-04-01', 'paper form', ''], ['12345', 'yes', '2025-04-01', 'paper form', ''], ['+91 98765 43210', 'yes', '2025-04-02', 'paper form', ''], ['9876543213', 'yes', 'someday', 'paper form', '']]);
  const d = await dryRun(h, T, 'dr-cust-1', 'customer-v1', bad);
  expect(d.errors.map((e) => `${e.line}:${e.column}`).sort()).toEqual(['3:loyaltyConsent', '4:mobile', '5:mobile', '6:consentGivenOn']);
  // P-04: the kept dry run never holds a mobile number.
  const kept = JSON.stringify((await get(h, T, MGR, '/v1/import/dry-runs')).body);
  expect(kept).not.toMatch(/987654321\d|98765 43210/);
  expect(kept).toContain('ending 3210');
  const good = csv(header, [['9876543210', 'yes', '2025-04-01', 'paper form', 'Lakshmi R'], ['9876543212', 'yes', '2025-06-10', 'old ERP card', '']]);
  committed(await commit(h, T, 'J-CUST', 'customer-v1', good));
  const look = async (mobile: string) => (await post(h, T, MGR, '/v1/loyalty/members/lookup', { mobile })).body as { member: boolean; memberRef?: string; mobileLast4?: string; pointsBalance?: number };
  const lakshmi = await look('9876543210');
  expect(lakshmi).toMatchObject({ member: true, mobileLast4: '3210' });
  const job = JSON.stringify((await get(h, T, OWNER, '/v1/import/commits/J-CUST')).body);
  expect(job).not.toMatch(/98765432\d\d/);
  expect(job).toContain(lakshmi.memberRef!);
  // A carried customer arrives with NO marketing consent.
  const consent = (await get(h, T, OWNER, `/v1/customers/${lakshmi.memberRef}/consent`)).body as { records?: { purpose: string; given: boolean }[] };
  expect(JSON.stringify(consent)).toContain('marketing');

  const ph = ['mobile', 'points', 'asOn'];
  const pd = await dryRun(h, T, 'dr-pts-1', 'loyalty-opening-v1', csv(ph, [['9876543210', 500, '2026-10-20'], ['9999999999', 50, '2026-10-20'], ['9876543212', 0, '2026-10-20']]));
  expect(pd.errors.map((e) => `${e.line}:${e.column}`).sort()).toEqual(['3:mobile', '4:points']);
  committed(await commit(h, T, 'J-PTS', 'loyalty-opening-v1', csv(ph, [['9876543210', 500, '2026-10-20']])));
  expect((await look('9876543210')).pointsBalance).toBe(500);
  // A second opening for the same member is an exception — never an overwrite.
  const twice = await dryRun(h, T, 'dr-pts-2', 'loyalty-opening-v1', csv(ph, [['9876543210', 700, '2026-10-21']]));
  expect(twice.errors[0]!.message).toContain('never an opening');
  // The member who now has points is not undone by the customer load's rollback; the points load is undone first.
  expect(codeOf(await rollback(h, T, 'J-CUST'))).toBe('import_effect_in_use');
  expect((await rollback(h, T, 'J-PTS')).status).toBe(200);
  expect((await look('9876543210')).pointsBalance).toBe(0);
}

async function permissions(h: ApiHarness, T: string): Promise<void> {
  // A cashier cannot check or load a file; a manager cannot approve their own load.
  expect((await post(h, T, CASHIER, '/v1/import/dry-runs/dr-x', { templateId: 'supplier-v1', text: 'supplierId,name\nX,Y' })).status).toBe(403);
  const templates = ((await get(h, T, MGR, '/v1/import/templates')).body as { templates: { id: string }[] }).templates.map((t) => t.id);
  expect(templates).toEqual(expect.arrayContaining(['supplier-v1', 'price-list-v1', 'opening-stock-v1', 'customer-v1', 'loyalty-opening-v1']));
}

describe('OB-315 — every domain imports with a dry run, its own rules and an undo (in memory)', () => {
  it('suppliers, price lists, opening stock, customers and opening points', async () => {
    const T = 'ab000000-0000-4000-8000-0000000315a1';
    const h = apiHarness();
    await seed(h, T);
    await permissions(h, T);
    await suppliers(h, T);
    await prices(h, T);
    await openingStock(h, T);
    await customersAndPoints(h, T);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('OB-315 — every domain imports, on PostgreSQL across a cold restart', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it('the loads, their dry runs and their undo are durable', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await seed(h, T);
    await suppliers(h, T);
    await prices(h, T);
    const again = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    // After a restart: the dry runs and the commits are still there.
    expect(((await get(again, T, MGR, '/v1/import/dry-runs')).body as { total: number }).total).toBe(2);
    expect(((await get(again, T, MGR, '/v1/import/commits')).body as { jobs: { jobId: string; rolledBack?: unknown }[] }).jobs.find((j) => j.jobId === 'J-SUP')!.rolledBack).toBeDefined();
    await openingStock(again, T);
    await customersAndPoints(again, T);
  }, 120_000);
});
