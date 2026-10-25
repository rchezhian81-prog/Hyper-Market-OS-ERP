import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { EXPORT_COVERAGE, MORE_EXPORT_SPECS } from '../../services/purchase/src/data-export';
import { assessShiftClose } from '../../packages/till/src/index';

/**
 * **OB-288 P2 · M30-FR-02 — every further business domain exports in an open format with its schema, scoped, redacted
 * and logged.**
 *
 * Price lists, promotions, goods receipts, supplier invoices, returns, stock movements (a bounded period), transfers,
 * counts, till shifts, write-offs, waste and service cases are all offered (the coverage register says each is exported
 * here); the rows equal what their registers hold; a store-limited manager gets their store's rows only; a sensitive
 * column (the customer's own words on a service case) is redacted for someone without `export.sensitive`; a period
 * domain refuses an unbounded export; every export is on the export log. In memory and on PostgreSQL across a restart.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr-s2'; const BOX = 'u-box'; const BOX2 = 'u-box-2';
type Csv = string[][];
const parse = (csv: string): Csv => csv.trim().split('\n').map((l) => l.split(','));
const col = (rows: Csv, name: string): string[] => { const i = rows[0]!.indexOf(name); return rows.slice(1).map((r) => r[i]!); };
const post = (h: ApiHarness, T: string, userId: string, path: string, body: unknown, branchId?: string) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body, ...(branchId === undefined ? {} : { branchId }) });

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager', ['S2']);
  await h.provisionRole(T, BOX, 'store_computer', ['S1']);
  await h.provisionRole(T, BOX2, 'store_computer', ['S2']);
  const at = '2026-10-10T05:00:00.000Z';
  const ok = async (userId: string, path: string, body: unknown, branchId?: string) => { const r = await post(h, T, userId, path, body, branchId); expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300); };
  for (const [loc, w, v] of [['S1', 'W-1', 4_500], ['S2', 'W-2', 1_200]] as const) {
    await ok(OWNER, `/v1/waste/records/${w}`, { branchId: loc, departmentId: 'D-FRESH', productId: 'P-TOM', source: 'expiry', at, valueMinor: v, disposal: 'composted' });
  }
  await ok(OWNER, '/v1/inventory/movements', { movementId: 'mv-1', productId: 'P-RICE', locationId: 'S1', kind: 'received', quantityMinor: 40, uom: 'ea', occurredAt: at, enteredBy: OWNER, unitCostMinor: 400_00 });
  await ok(OWNER, '/v1/inventory/movements', { movementId: 'mv-2', productId: 'P-RICE', locationId: 'S2', kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: '2026-08-01T05:00:00.000Z', enteredBy: OWNER, unitCostMinor: 400_00 });
  // A till close at each store, as each store computer relays it.
  for (const [box, store, shift, counted] of [[BOX, 'S1', 'SH-1', 115_000], [BOX2, 'S2', 'SH-2', 113_000]] as const) {
    const b = { openingFloatMinor: 50_000, cashSalesMinor: 100_000, pickupsMinor: 30_000, cashRefundsMinor: 5_000, countedCashMinor: counted, toleranceMinor: 500, reasonCode: 'note_miscounted' };
    const d = assessShiftClose(b);
    await ok(box, `/v1/shifts/${shift}/close/synced`, {
      tillId: `lane-${store}`, cashierId: 'c-1', tradingDay: '2026-10-10', openingFloatMinor: 50_000, cashSalesMinor: 100_000, pickupsMinor: 30_000, cashRefundsMinor: 5_000,
      toleranceMinor: 500, reasonCode: 'note_miscounted', laneId: `lane-${store}`, openedAt: at, closedAt: at,
      countedMinor: counted, expectedMinor: d.expectedMinor, varianceMinor: d.varianceMinor, exceptionRaised: d.exceptionRaised,
    }, store);
  }
  await h.provisionRole(T, 'u-cash1', 'cashier');
  await ok(OWNER, '/v1/tills/lane-S1/cash-movements', { movementId: 'cm-1', kind: 'float_issue', amountMinor: 50_000, currency: 'INR', custodianId: 'u-cash1', tradingDay: '2026-10-10', storeId: 'S1' });
  await ok(OWNER, '/v1/service/cases/k1', { kind: 'complaint', customerRef: 'm-member-1', priority: 'normal', summary: 'wrong item delivered', assignedTo: OWNER });
}

async function checks(h: ApiHarness, T: string): Promise<void> {
  const exp = (userId: string, domain: string, body: unknown = {}, branchId?: string) => post(h, T, userId, `/v1/export/${domain}`, body, branchId);
  // Every further domain is offered, and the coverage register says so.
  const listed = ((await h.request({ method: 'GET', path: '/v1/export', userId: OWNER, tenantId: T })).body as { domains: { domain: string }[] }).domains.map((d) => d.domain);
  expect(listed).toEqual(expect.arrayContaining(Object.keys(MORE_EXPORT_SPECS)));
  const cov = (await h.request({ method: 'GET', path: '/v1/export/coverage', userId: OWNER, tenantId: T })).body as { coverage: { exportDomain?: string; status: string; offeredHere: boolean; why?: string }[] };
  expect(cov.coverage).toHaveLength(EXPORT_COVERAGE.length);
  expect(cov.coverage.filter((c) => c.status === 'exported').every((c) => c.offeredHere)).toBe(true);
  expect(cov.coverage.filter((c) => c.status === 'not_yet').every((c) => (c.why ?? '').length > 10)).toBe(true);

  // Every further domain exports for the owner — an open CSV with its schema, even when its register is still empty.
  for (const domain of Object.keys(MORE_EXPORT_SPECS)) {
    const r = await exp(OWNER, domain, MORE_EXPORT_SPECS[domain]!.period === undefined ? {} : { from: '2026-10-01', to: '2026-10-31' });
    expect(r.status, `${domain} ${JSON.stringify(r.body)}`).toBe(200);
    expect(parse((r.body as { csv: string }).csv)[0]).toEqual(MORE_EXPORT_SPECS[domain]!.spec.columns.map((c) => c.name));
  }
  // Waste records and till shifts: what the registers hold; the S2 manager signed in at S2 gets S2's only.
  const waste = parse(((await exp(OWNER, 'waste-records')).body as { csv: string }).csv);
  expect(col(waste, 'wasteId').sort()).toEqual(['W-1', 'W-2']);
  const mineWaste = parse(((await exp(MGR, 'waste-records', {}, 'S2')).body as { csv: string }).csv);
  expect(col(mineWaste, 'wasteId')).toEqual(['W-2']);
  const shifts = parse(((await exp(OWNER, 'till-shifts')).body as { csv: string }).csv);
  expect(col(shifts, 'shiftId').sort()).toEqual(['SH-1', 'SH-2']);
  expect(col(shifts, 'varianceMinor').map(Number).sort((a, b) => a - b)).toEqual([-2_000, 0]);
  // Cash movements: the till's float, one by one.
  const cash = parse(((await exp(OWNER, 'cash-movements')).body as { csv: string }).csv);
  expect(col(cash, 'movementId')).toEqual(['cm-1']);
  expect(col(cash, 'store')).toEqual(['S1']);
  expect(col(cash, 'deltaMinor')).toEqual(['50000']);
  // Stock movements: bounded — refused without a period, and only the period's movements with one.
  const unbounded = await exp(OWNER, 'stock-movements');
  expect(unbounded.status).toBe(400);
  const october = parse(((await exp(OWNER, 'stock-movements', { from: '2026-10-01', to: '2026-10-31' })).body as { csv: string }).csv);
  expect(col(october, 'movementId')).toEqual(['mv-1']);
  expect((await exp(OWNER, 'stock-movements', { from: '2026-01-01', to: '2026-12-31' })).status).toBe(400);
  // Service cases: the customer's own words are REDACTED for the manager (no export.sensitive), shown to the owner.
  const ownCases = parse(((await exp(OWNER, 'service-cases')).body as { csv: string }).csv);
  expect(col(ownCases, 'summary')).toEqual(['wrong item delivered']);
  const mgrCases = await exp(MGR, 'service-cases', {}, 'S2');
  expect((mgrCases.body as { audit: { redactedColumns: string[] } }).audit.redactedColumns).toEqual(expect.arrayContaining(['summary', 'customerRef']));
  // Logged.
  const log = ((await h.request({ method: 'GET', path: '/v1/exports', userId: OWNER, tenantId: T })).body as { exports: { userId: string; domain: string }[] }).exports;
  expect(log.some((e) => e.domain === 'service-cases' && e.userId === MGR)).toBe(true);
}

describe('M30-FR-02 — the further domains export (OB-288 P2, in memory)', () => {
  it('offered, equal to their registers, scoped, redacted, bounded and logged', async () => {
    const T = 'ab000000-0000-4000-8000-0000000e3f02';
    const h = apiHarness();
    await seed(h, T);
    await checks(h, T);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('M30-FR-02 — the further domains export on PostgreSQL, through a restart', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it('the same from a fresh head office over the same database', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    await seed(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }), T);
    await checks(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }), T);
  }, 120_000);
});
