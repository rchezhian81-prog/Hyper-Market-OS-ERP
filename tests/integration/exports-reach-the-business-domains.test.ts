import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { EXPORT_COVERAGE } from '../../services/purchase/src/data-export';

/**
 * **The governed export reaches the business domains, scoped, redacted and logged (audit SF-10 · M30-FR-02/04 · P-06).**
 *
 * The audit found the export console covering two domains. Through the real API: sales (from the sales ledger), stock on
 * hand (the stock ledger), the supplier master and the ledger journals export as open CSV on the existing engine — each
 * equal to its domain's own read; a store-limited manager signed in at S2 exports only S2's bills; a column marked
 * sensitive (the member code, a supplier's phone) is REDACTED for someone without `export.sensitive` and shown to the
 * owner; a cashier is refused; every export is on the append-only export log with its row count and redactions; and the
 * coverage register says, domain by domain, what can be taken out and what not yet — with why. In memory and on PostgreSQL.
 */

const OWNER = 'u-owner'; const S2_MANAGER = 'u-mgr-s2'; const CASHIER = 'u-cash';
const DAY = '2026-10-09';

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, CASHIER, 'cashier');
  await h.provisionRole(T, S2_MANAGER, 'store_manager', ['S2']);
  const ok = async (userId: string, method: 'POST' | 'PUT', path: string, body: unknown, key: string) => {
    const r = await h.request({ method, path, userId, tenantId: T, idempotencyKey: key, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  for (const [saleId, loc, total, member] of [['B-1', 'S1', 30_000, 'MEM-77'], ['B-2', 'S2', 12_000, undefined], ['B-3', 'S2', 9_000, undefined]] as const) {
    await ok(CASHIER, 'POST', '/v1/sales', {
      saleId, receiptNumber: `R-${saleId}`, laneId: `lane-${loc}`, locationId: loc, cashierId: CASHIER, tradingDay: DAY, committedAt: `${DAY}T05:00:00.000Z`,
      totalMinor: total, currency: 'INR', packVersion: 1, lines: [{ productId: 'P-X', quantityMinor: 1, uom: 'ea', unitPriceMinor: total, lineTotalMinor: total }],
      tenders: [{ kind: 'cash', amountMinor: total }], ...(member === undefined ? {} : { customerRef: member }),
    }, `sale-${saleId}`);
  }
  await ok(OWNER, 'POST', '/v1/inventory/movements', { movementId: 'mv-1', productId: 'P-RICE', locationId: 'S1', kind: 'received', quantityMinor: 40, uom: 'ea', occurredAt: `${DAY}T01:00:00.000Z`, enteredBy: OWNER, unitCostMinor: 400_00 }, 'mv-1');
  await approvedSuppliers(h, T, 'SUP-A');
  await ok(OWNER, 'POST', '/v1/finance/journals', { entryId: 'JE-1', period: '2026-10', documentDate: DAY, narrative: 'Synthetic rent accrual', postedBy: OWNER, lines: [{ accountCode: 'rent_expense', debitMinor: 50_000, creditMinor: 0 }, { accountCode: 'accrued_rent', debitMinor: 0, creditMinor: 50_000 }] }, 'je-1');
}

type Csv = string[][];
const parse = (csv: string): Csv => csv.trim().split('\n').map((l) => l.split(','));
const exp = async (h: ApiHarness, T: string, userId: string, domain: string, key: string, branchId?: string) =>
  h.request({ method: 'POST', path: `/v1/export/${domain}`, userId, tenantId: T, idempotencyKey: key, ...(branchId === undefined ? {} : { branchId }) });
const col = (rows: Csv, name: string): string[] => { const i = rows[0]!.indexOf(name); return rows.slice(1).map((r) => r[i]!); };

async function checks(h: ApiHarness, T: string): Promise<void> {
  // The coverage register: every domain, exported here or not yet with why.
  const covRes = await h.request({ method: "GET", path: "/v1/export/coverage", userId: OWNER, tenantId: T });
  expect(covRes.status, JSON.stringify(covRes.body)).toBe(200);
  const cov = covRes.body as { coverage: { exportDomain?: string; status: string; offeredHere: boolean; why?: string }[] };
  expect(cov.coverage.filter((c) => c.status === 'exported').every((c) => c.offeredHere)).toBe(true);
  expect(cov.coverage.filter((c) => c.status === 'not_yet').every((c) => (c.why ?? '').length > 10)).toBe(true);
  expect(cov.coverage).toHaveLength(EXPORT_COVERAGE.length);

  // SALES — every bill, to the paisa; the member code shown to the owner (export.sensitive).
  const sales = await exp(h, T, OWNER, 'sales', `sales-own-${T}`);
  expect(sales.status, JSON.stringify(sales.body)).toBe(200);
  const rows = parse((sales.body as { csv: string }).csv);
  expect(col(rows, 'saleId').sort()).toEqual(['B-1', 'B-2', 'B-3']);
  expect(col(rows, 'totalMinor').map(Number).reduce((a, b) => a + b, 0)).toBe(51_000);
  expect(col(rows, 'memberRef')).toContain('MEM-77');

  // The S2 manager, signed in at S2: only S2's bills; the member column REDACTED (no export.sensitive).
  const mine = await exp(h, T, S2_MANAGER, 'sales', `sales-s2-${T}`, 'S2');
  expect(mine.status, JSON.stringify(mine.body)).toBe(200);
  const s2 = parse((mine.body as { csv: string }).csv);
  expect(col(s2, 'saleId').sort()).toEqual(['B-2', 'B-3']);
  expect((mine.body as { audit: { redactedColumns: string[] } }).audit.redactedColumns).toContain('memberRef');
  // A cashier cannot export at all.
  expect((await exp(h, T, CASHIER, 'sales', `sales-cash-${T}`)).status).toBe(403);

  // STOCK — equal to the stock ledger's own availability read.
  const stock = parse(((await exp(h, T, OWNER, 'stock-on-hand', `stock-${T}`)).body as { csv: string }).csv);
  const avail = ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OWNER, tenantId: T })).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows;
  const fromExport = col(stock, 'productId').map((p, i) => `${p}@${col(stock, 'store')[i]}=${col(stock, 'onHandMinor')[i]}`).sort();
  expect(fromExport).toEqual(avail.map((r) => `${r.productId}@${r.locationId}=${r.onHandMinor}`).sort());
  expect(fromExport).toContain('P-RICE@S1=40');

  // SUPPLIERS — the master's approved supplier.
  const sup = parse(((await exp(h, T, OWNER, 'suppliers', `sup-${T}`)).body as { csv: string }).csv);
  expect(col(sup, 'supplierId')).toEqual(['SUP-A']);
  expect(col(sup, 'status')).toEqual(['active']);

  // LEDGER JOURNALS — one row per line, balanced.
  const je = parse(((await exp(h, T, OWNER, 'ledger-journals', `je-${T}`)).body as { csv: string }).csv);
  expect(col(je, 'account').sort()).toEqual(['accrued_rent', 'rent_expense']);
  expect(col(je, 'debitMinor').map(Number).reduce((a, b) => a + b, 0)).toBe(col(je, 'creditMinor').map(Number).reduce((a, b) => a + b, 0));

  // THE EXPORT LOG — who took what, how many rows, what was redacted.
  const log = ((await h.request({ method: 'GET', path: '/v1/exports', userId: OWNER, tenantId: T })).body as { exports: { userId: string; domain: string; rowCount: number; redactedColumns: string[] }[] }).exports;
  expect(log.find((e) => e.userId === S2_MANAGER && e.domain === 'sales')).toMatchObject({ rowCount: 2, redactedColumns: expect.arrayContaining(['memberRef']) });
  expect(log.filter((e) => e.userId === OWNER).map((e) => e.domain).sort()).toEqual(['ledger-journals', 'sales', 'stock-on-hand', 'suppliers']);
}

describe('the governed export reaches the business domains (SF-10)', () => {
  it('in memory', async () => {
    const T = 'ab000000-0000-4000-8000-0000000sf010'.replace('sf', '5f');
    const h = apiHarness();
    await seed(h, T);
    await checks(h, T);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('the governed export reaches the business domains — real PostgreSQL (SF-10)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same on PostgreSQL', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await seed(h, T);
    await checks(h, T);
  });
});
