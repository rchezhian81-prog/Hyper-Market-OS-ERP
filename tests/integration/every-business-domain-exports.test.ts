import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { approvedRequestId } from '../support/approval-request';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, MemoryIdempotencyStore } from '../../services/kernel/src/index';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';
import { EXPORT_COVERAGE } from '../../services/purchase/src/data-export';
import { REDACTED } from '../../packages/export/src/export';

/**
 * **Every business domain leaves through the one governed export — purchase orders, customers, loyalty, orders and payroll
 * (audit SF-10 round 5 · M30-FR-02 / M30-FR-04 · P-04 · P-06 · hard rules #2, #6).**
 *
 * Through the real API, in memory and on PostgreSQL, each domain is exported on the EXISTING engine from its OWN read
 * model and compared with that domain's own read: the purchase orders equal `GET /v1/purchase/orders`, the loyalty wallets
 * equal the store computers' feed `GET /v1/loyalty/wallets`, each customer's consent equals `GET /v1/customers/:id/consent`,
 * each order's state equals `GET /v1/orders/:id`, each payslip equals `GET /v1/hr/payroll/payslips/:employeeId`. Then:
 *   • SCOPE — a store manager signed in at S2 exports only S2's purchase orders and orders; a payroll holder limited to S2
 *     exports only S2's staff's payslips;
 *   • REDACTION — a customer's member code, last four digits and consent evidence, a loyalty member code and an order's
 *     customer are [redacted] for someone without export.sensitive and shown to the owner; payroll carries no bank detail
 *     at all and is never a bank file;
 *   • 403 — a cashier exports nothing; a store manager cannot export payroll; an accountant cannot export customers;
 *   • the EXPORT LOG records every export with its row count and redactions, and the coverage register lists every domain;
 *   • M30-FR-04 — an import's job history, row-level errors and a second-person ROLLBACK (compensating records, the job
 *     kept), and the import-commits export says the load was rolled back and who approved it.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const MGR_S2 = 'u-mgr-s2'; const PAY_S2 = 'u-pay-s2'; const CASHIER = 'u-cash'; const BOOKS = 'u-books';
const MOBILE_A = '98400 11111'; const MOBILE_B = '98400 22222';
const MEMBER_A = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), MOBILE_A)!;
const MEMBER_B = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), MOBILE_B)!;
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const RICE = { sku: 'RICE5', name: 'Rice 5kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'draft', mrpHistory: [{ value: { minor: 50_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] };

type Csv = string[][];
const parse = (csv: string): Csv => csv.trim().split('\n').map((l) => l.split(','));
const col = (rows: Csv, name: string): string[] => { const i = rows[0]!.indexOf(name); expect(i, `column ${name}`).toBeGreaterThanOrEqual(0); return rows.slice(1).map((r) => r[i]!); };

async function seed(h: ApiHarness, T: string): Promise<void> {
  let n = 0;
  const ok = async (userId: string, method: 'POST' | 'PUT', path: string, body: unknown, status?: number) => {
    const r = await h.request({ method, path, userId, tenantId: T, idempotencyKey: `seed-${++n}`, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(status ?? r.status);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body;
  };
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager');
  await h.provisionRole(T, MGR_S2, 'store_manager', ['S2']);
  await h.provisionRole(T, PAY_S2, 'owner', ['S2']); // payroll authority, one branch
  await h.provisionRole(T, CASHIER, 'cashier');
  await h.provisionRole(T, BOOKS, 'accountant');
  await deliveryPlaces(h, T, 'S1');
  await deliveryPlaces(h, T, 'S2');
  await approvedSuppliers(h, T, 'SUP-A');
  await ok(OWNER, 'POST', '/v1/catalogue/products/P-RICE/publish', { product: RICE, categories: [GROCERY] });

  // PURCHASE ORDERS — one to each store; S1's issued by a second person.
  const line = { productId: 'P-RICE', orderedQty: 10, unitCost: { minor: 40_000, currency: 'INR' } };
  await ok(MGR, 'POST', '/v1/purchase/orders/PO-1', { supplierId: 'SUP-A', deliverToLocationId: 'S1', lines: [line] });
  await ok(OWNER, 'POST', '/v1/purchase/orders/PO-1/approval', { reason: 'fixture' });
  await ok(MGR, 'POST', '/v1/purchase/orders/PO-2', { supplierId: 'SUP-A', deliverToLocationId: 'S2', lines: [{ ...line, orderedQty: 4 }] });

  // CUSTOMERS + LOYALTY — two members enrolled at the desk; one gives marketing consent by SMS and then withdraws it.
  await ok(OWNER, 'PUT', '/v1/platform/setup/loyalty.points_per_100_inr', { value: 1 });
  await ok(OWNER, 'PUT', '/v1/platform/setup/loyalty.point_value_paise', { value: 100 });
  await ok(MGR, 'POST', '/v1/loyalty/members', { mobile: MOBILE_A, consent: true, verifiedHow: 'seen_on_phone' });
  await ok(MGR, 'POST', '/v1/loyalty/members', { mobile: MOBILE_B, consent: true, verifiedHow: 'seen_on_phone' });
  await ok(MGR, 'POST', `/v1/customers/${MEMBER_A}/consent`, { purpose: 'marketing', channel: 'sms', given: true, evidence: 'ticked the box on the desk form' });
  await ok(MGR, 'POST', `/v1/customers/${MEMBER_A}/consent`, { purpose: 'marketing', channel: 'sms', given: false, evidence: 'replied STOP to the shop number' });
  // A ₹2,000 bill for member A earns 20 points; ₹150 store credit for member B.
  await h.provisionRole(T, 'u-box', 'store_computer');
  const bill = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: T, idempotencyKey: 'sale-1', body: {
    saleId: 'B-1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'S1', cashierId: CASHIER, tradingDay: '2026-10-09', committedAt: new Date().toISOString(),
    totalMinor: 200_000, currency: 'INR', packVersion: 1, customerRef: MEMBER_A,
    lines: [{ productId: 'P-RICE', quantityMinor: 4, uom: 'ea', unitPriceMinor: 50_000, lineTotalMinor: 200_000 }], tenders: [{ kind: 'cash', amountMinor: 200_000 }],
  } });
  expect(bill.status, JSON.stringify(bill.body)).toBeLessThan(300);
  await ok(OWNER, 'POST', '/v1/stored-value/instruments', { instrumentId: 'sc-b', kind: 'store_credit', ownerRef: MEMBER_B, faceValueMinor: 15_000 });

  // ORDERS — one at each store; S1's confirmed.
  await ok(OWNER, 'POST', '/v1/orders/O-1/promise', { lines: [{ productId: 'P-RICE', quantityMinor: 2 }], locationId: 'S1' });
  await ok(OWNER, 'POST', '/v1/orders/O-1/transition', { event: 'confirm' });
  await ok(OWNER, 'POST', '/v1/orders/O-2/promise', { lines: [{ productId: 'P-RICE', quantityMinor: 1 }], locationId: 'S2' });

  // PAYROLL — two staff, one per branch, each with an issued payslip computed by the payslip engine.
  for (const [emp, branchId, basic] of [['E-1', 'S1', 1_200_000], ['E-2', 'S2', 1_500_000]] as const) {
    await ok(OWNER, 'POST', `/v1/hr/workforce/employees/${emp}`, { name: `Staff ${emp}`, branchId, roles: ['cashier'], active: true, hourlyRateMinor: 12_000 });
    const payslip = await ok(OWNER, 'POST', '/v1/hr/payroll/payslip', { onDate: '2026-09-30', components: [{ code: 'BASIC', monthlyMinor: basic, partOfPfWage: true }], attendance: { calendarDaysInMonth: 30, paidDays: 30 } });
    await ok(OWNER, 'POST', `/v1/hr/payroll/payslips/${emp}/2026-09`, { payslip });
  }
}

async function checks(h: ApiHarness, T: string, again: () => ApiHarness): Promise<void> {
  let k = 0;
  const exp = (userId: string, domain: string, branchId?: string) =>
    h.request({ method: 'POST', path: `/v1/export/${domain}`, userId, tenantId: T, idempotencyKey: `exp-${domain}-${userId}-${++k}`, ...(branchId === undefined ? {} : { branchId }) });
  const csvOf = async (userId: string, domain: string, branchId?: string) => {
    const r = await exp(userId, domain, branchId);
    expect(r.status, `${domain} for ${userId}: ${JSON.stringify(r.body)}`).toBe(200);
    return { rows: parse((r.body as { csv: string }).csv), audit: (r.body as { audit: { rowCount: number; redactedColumns: string[] } }).audit };
  };
  const get = async (path: string, userId = OWNER) => (await h.request({ method: 'GET', path, userId, tenantId: T })).body;

  // ── The coverage register: every domain now exported, attendance named as not yet with why.
  const cov = (await get('/v1/export/coverage')) as { coverage: { domain: string; status: string; offeredHere: boolean; why?: string }[] };
  expect(cov.coverage).toHaveLength(EXPORT_COVERAGE.length);
  expect(cov.coverage.filter((c) => c.status === 'exported').every((c) => c.offeredHere)).toBe(true);
  expect(cov.coverage.filter((c) => c.status === 'not_yet').map((c) => c.domain)).toEqual(['Attendance hours']);

  // ── PURCHASE ORDERS — equal to the purchase domain's own list; S2's manager gets S2's only.
  const po = await csvOf(OWNER, 'purchase-orders');
  const listed = ((await get('/v1/purchase/orders')) as { orders: { poId: string; status: string; totalMinor: number; deliverTo: string; approvedBy: string | null }[] }).orders;
  expect(col(po.rows, 'poId').map((id, i) => `${id}|${col(po.rows, 'status')[i]}|${col(po.rows, 'totalMinor')[i]}|${col(po.rows, 'store')[i]}|${col(po.rows, 'approvedBy')[i]}`).sort())
    .toEqual(listed.map((o) => `${o.poId}|${o.status}|${o.totalMinor}|${o.deliverTo}|${o.approvedBy ?? ''}`).sort());
  expect(col(po.rows, 'poId').sort()).toEqual(['PO-1', 'PO-2']);
  expect(col((await csvOf(MGR_S2, 'purchase-orders', 'S2')).rows, 'poId')).toEqual(['PO-2']);

  // ── CUSTOMERS — personal data. The owner sees the member codes, last four digits and evidence; the latest consent
  // per purpose and channel equals the consent ledger's own answer.
  const cust = await csvOf(OWNER, 'customers');
  expect(col(cust.rows, 'customerRef').sort()).toEqual([MEMBER_A, MEMBER_B].sort());
  expect(col(cust.rows, 'mobileLast4').sort()).toEqual(['1111', '2222']);
  const consentA = col(cust.rows, 'consent')[col(cust.rows, 'customerRef').indexOf(MEMBER_A)]!;
  const ledger = ((await get(`/v1/customers/${MEMBER_A}/consent`)) as { records: { purpose: string; channel: string; given: boolean; recordedAt: string }[] }).records;
  const latest = ledger.at(-1)!;
  expect(consentA).toBe(`${latest.purpose}/${latest.channel}=${latest.given ? 'given' : 'withdrawn'}@${latest.recordedAt}`);
  expect(consentA).toContain('marketing/sms=withdrawn');
  // No column carries a full mobile number or an email — the shop holds neither.
  expect(cust.rows[0]!.some((c) => /^(mobile|phone|email)$/i.test(c))).toBe(false);
  expect(JSON.stringify(cust.rows)).not.toContain('98400');
  // A store manager may read customers, but without export.sensitive the identifying columns are REDACTED, not dropped.
  const mgrCust = await csvOf(MGR, 'customers');
  expect(new Set(col(mgrCust.rows, 'customerRef'))).toEqual(new Set([REDACTED]));
  expect(new Set(col(mgrCust.rows, 'mobileLast4'))).toEqual(new Set([REDACTED]));
  expect(col(mgrCust.rows, 'status')).toEqual(['member', 'member']);
  expect(mgrCust.audit.redactedColumns.sort()).toEqual(['consentEvidence', 'customerRef', 'mobileLast4']);
  // An accountant holds no customer authority at all; a cashier no export at all.
  expect((await exp(BOOKS, 'customers')).status).toBe(403);
  expect((await exp(CASHIER, 'customers')).status).toBe(403);

  // ── LOYALTY — equal to the store computers' wallet feed, to the point and the paisa.
  const loy = await csvOf(OWNER, 'loyalty-wallets');
  const feed = (await get('/v1/loyalty/wallets')) as { members: { memberRef: string; points: number; storeCreditMinor: number }[]; rule: { pointValuePaise: number } };
  expect(col(loy.rows, 'memberRef').map((m, i) => `${m}|${col(loy.rows, 'points')[i]}|${col(loy.rows, 'storeCreditMinor')[i]}`).sort())
    .toEqual(feed.members.map((m) => `${m.memberRef}|${m.points}|${m.storeCreditMinor}`).sort());
  expect(col(loy.rows, 'points').map(Number).reduce((a, b) => a + b, 0)).toBe(20);
  expect(col(loy.rows, 'storeCreditMinor').map(Number).reduce((a, b) => a + b, 0)).toBe(15_000);
  expect(col(loy.rows, 'pointsValueMinor').map(Number).reduce((a, b) => a + b, 0)).toBe(20 * feed.rule.pointValuePaise);
  expect(new Set(col((await csvOf(MGR, 'loyalty-wallets')).rows, 'memberRef'))).toEqual(new Set([REDACTED]));

  // ── ORDERS — every order at its current state, as the order domain folds it; S2's manager gets S2's only.
  const ord = await csvOf(OWNER, 'orders');
  for (const [i, id] of col(ord.rows, 'orderId').entries()) {
    const own = (await get(`/v1/orders/${id}`)) as { state: string; locationId: string };
    expect(`${col(ord.rows, 'state')[i]}@${col(ord.rows, 'store')[i]}`).toBe(`${own.state}@${own.locationId}`);
  }
  expect(col(ord.rows, 'orderId').sort()).toEqual(['O-1', 'O-2']);
  expect(col(ord.rows, 'state')[col(ord.rows, 'orderId').indexOf('O-1')]).not.toBe(col(ord.rows, 'state')[col(ord.rows, 'orderId').indexOf('O-2')]); // O-1 moved on
  expect(col((await csvOf(MGR_S2, 'orders', 'S2')).rows, 'orderId')).toEqual(['O-2']);

  // ── PAYROLL — read-only, payroll authority only, scoped to the employee's branch; no bank detail, ever.
  const pay = await csvOf(OWNER, 'payslips');
  for (const emp of ['E-1', 'E-2']) {
    const own = (await get(`/v1/hr/payroll/payslips/${emp}`)) as { periods: { period: string; netPayMinor: number }[] };
    const i = col(pay.rows, 'employeeId').indexOf(emp);
    expect(`${col(pay.rows, 'period')[i]}|${col(pay.rows, 'netPayMinor')[i]}`).toBe(`${own.periods[0]!.period}|${own.periods[0]!.netPayMinor}`);
  }
  expect(col(pay.rows, 'branch').sort()).toEqual(['S1', 'S2']);
  expect(pay.rows[0]!.some((c) => /bank|account|ifsc/i.test(c))).toBe(false);
  expect(pay.audit.redactedColumns).toEqual([]); // the owner holds export.sensitive
  const s2pay = await csvOf(PAY_S2, 'payslips', 'S2');
  expect(col(s2pay.rows, 'employeeId')).toEqual(['E-2']);
  expect((await exp(MGR, 'payslips')).status).toBe(403);   // a store manager holds no payroll authority
  expect((await exp(BOOKS, 'payslips')).status).toBe(403);
  expect((await exp(PAY_S2, 'payslips', 'S1')).status).toBe(403); // a branch not held

  // ── THE EXPORT LOG — every export, who, how many rows, what was redacted; it survives a restart.
  const log = ((await again().request({ method: 'GET', path: '/v1/exports', userId: OWNER, tenantId: T })).body as { exports: { userId: string; domain: string; rowCount: number; branchId: string | null; redactedColumns: string[] }[] }).exports;
  expect(log.find((e) => e.userId === MGR && e.domain === 'customers')).toMatchObject({ rowCount: 2, redactedColumns: expect.arrayContaining(['mobileLast4']) });
  expect(log.find((e) => e.userId === PAY_S2 && e.domain === 'payslips')).toMatchObject({ rowCount: 1, branchId: 'S2' });
  expect(log.filter((e) => e.userId === OWNER).map((e) => e.domain).sort()).toEqual(['customers', 'loyalty-wallets', 'orders', 'payslips', 'purchase-orders']);
  expect(log.some((e) => e.userId === CASHIER || e.userId === BOOKS)).toBe(false); // a refused export takes nothing and logs nothing
}

/** M30-FR-04: job history, row-level errors, a second-person rollback with compensating records — and the export says so. */
async function importHistoryAndRollback(h: ApiHarness, T: string): Promise<void> {
  const post = (userId: string, path: string, body: unknown) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `imp-${randomUUID()}`, body });
  const get = async (path: string) => (await h.request({ method: 'GET', path, userId: OWNER, tenantId: T })).body;
  const HEADER = 'productId,sku,name,baseUom,primaryCategoryId,taxClass,brand,allergens,countryOfOrigin,netQuantity,packerDetails,minimumAge';
  await post(OWNER, '/v1/catalogue/categories/home', { name: 'Home care', parentId: null });
  // Row-level errors, by line, and a bad file loads nothing.
  const bad = (await post(OWNER, '/v1/import/validate', { templateId: 'product-v1', text: [HEADER, 'p-x,X1,X,each,nowhere,1,,,,,,'].join('\n') })).body as { preview: { errors: { line: number; column: string }[]; commitReady: boolean } };
  expect(bad.preview.errors.map((e) => `${e.line}:${e.column}`)).toContain('2:primaryCategoryId');
  expect(bad.preview.commitReady).toBe(false);
  // A good file: checked, approved by a second person, loaded.
  const text = [HEADER, 'p-soap,SOAP,Soap,each,home,3401,,,,,,'].join('\n');
  const fp = ((await post(OWNER, '/v1/import/validate', { templateId: 'product-v1', text })).body as { contentFingerprint: string }).contentFingerprint;
  const approval = await approvedRequestId(h, T, OWNER, MGR, { kind: 'data_import_commit', subjectRef: 'J-1', details: { jobId: 'J-1', contentFingerprint: fp } });
  expect((await post(OWNER, '/v1/import/commit', { jobId: 'J-1', templateId: 'product-v1', text, approvalId: approval })).status).toBe(200);
  // The rollback: refused without a second person's approval; with it, the product is withdrawn by a compensating record.
  expect((await post(OWNER, '/v1/import/commits/J-1/rollback', { reason: 'wrong file' })).status).toBe(422);
  const undo = await approvedRequestId(h, T, OWNER, MGR, { kind: 'data_import_rollback', subjectRef: 'J-1', details: { jobId: 'J-1' } });
  expect((await post(OWNER, '/v1/import/commits/J-1/rollback', { reason: 'wrong file', approvalId: undo })).status).toBe(200);
  expect(((await get('/v1/catalogue/products/p-soap')) as { product: { lifecycle: string } }).product.lifecycle).toBe('discontinued');
  // The job history keeps the job and says it was rolled back; the export says the same, with the second person.
  const job = ((await get('/v1/import/commits')) as { jobs: { jobId: string; rowsApplied: number; rolledBack?: { approvedBy: string } }[] }).jobs.find((j) => j.jobId === 'J-1')!;
  expect(job).toMatchObject({ rowsApplied: 1, rolledBack: { approvedBy: MGR } });
  const ex = await h.request({ method: 'POST', path: '/v1/export/import-commits', userId: OWNER, tenantId: T, idempotencyKey: `exp-imp-${T}`, body: {} });
  const rows = parse((ex.body as { csv: string }).csv);
  const i = col(rows, 'jobId').indexOf('J-1');
  expect([col(rows, 'rolledBack')[i], col(rows, 'rollbackApprovedBy')[i]]).toEqual(['yes', MGR]);
}

describe('every business domain leaves through the governed export (SF-10 round 5)', () => {
  it('purchase orders, customers, loyalty, orders and payroll — own read, scope, redaction, 403 and the log (in memory)', async () => {
    const T = 'ab000000-0000-4000-8000-0000005f0105';
    const idem = new MemoryIdempotencyStore();
    const h = apiHarness({ idempotency: idem });
    await seed(h, T);
    await checks(h, T, () => apiHarness({ store: h.store, idempotency: idem }));
  });

  it('M30-FR-04: job history, row errors, a second-person rollback, and the export says the load was rolled back', async () => {
    const T = 'ab000000-0000-4000-8000-0000005f0104';
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await importHistoryAndRollback(h, T);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('every business domain leaves through the governed export — real PostgreSQL (SF-10 round 5)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same five domains on PostgreSQL, with the log read back after a restart', async () => {
    const sql = pgPoolClient(pool);
    const make = () => apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    const T = randomUUID();
    const h = make();
    await seed(h, T);
    await checks(h, T, make);
  });

  it('M30-FR-04 import history and rollback on PostgreSQL', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await importHistoryAndRollback(h, T);
  });
});
