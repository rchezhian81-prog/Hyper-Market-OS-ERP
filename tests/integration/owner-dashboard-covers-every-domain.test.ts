import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { tradingDayIn } from '../../packages/calendar/src/index';
import { KPI_DOMAINS } from '../../services/api/src/dashboard-figures';

/**
 * **OB-288 P2 — the owner's dashboard covers every domain M29-FR-01 names (sales, margin, cash, stock, purchase, customer,
 * fulfilment); the waste report carries energy, scrap proceeds and its drill-through (M28-FR-04); the security report is
 * produced (D13-FR-06).**
 *
 * Through the production route table, in memory and on PostgreSQL with a cold restart:
 *   • every domain is a block with its own figures and freshness, each figure from its catalogue report's producer, and a
 *     figure no record supports is "not available" with the reason — never nought (P-08). The sales block equals the
 *     Sales by day report; the stock block equals Stock on hand.
 *   • a manager scoped to S2 sees S2's sales in the headline and the sales block — never S1's (§28).
 *   • the waste report: energy and scrap are "not known" until recorded; once recorded they are on the report, with the
 *     waste records, scrap sales and readings behind the totals.
 *   • the security report: access given is counted from the identity ledger; failed sign-ins are NOT KNOWN, with why.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr-s2'; const CASHIER = 'u-cash';
const today = (): string => tradingDayIn(new Date().toISOString(), { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' });

type Fig = { name: string; valueMinor?: number; asAt: string | null; staleness: string; notAvailableBecause?: string };
type Block = { domain: string; reports: string[]; figures: Fig[]; asAt: string | null; worstStaleness: string };
type Dash = { figures: Fig[]; kpis: Block[]; scope: unknown };

const ok = async (h: ApiHarness, T: string, userId: string, path: string, body: unknown, branchId?: string): Promise<void> => {
  const r = await h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body, ...(branchId === undefined ? {} : { branchId }) });
  expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
};
const get = async (h: ApiHarness, T: string, userId: string, path: string, query?: Record<string, string>, branchId?: string) =>
  h.request({ method: 'GET', path, userId, tenantId: T, ...(query === undefined ? {} : { query }), ...(branchId === undefined ? {} : { branchId }) });

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, CASHIER, 'cashier');
  await h.provisionRole(T, MGR, 'store_manager', ['S2']);
  const day = today();
  const at = new Date(Date.now() - 60_000).toISOString();
  for (const [saleId, loc, total] of [['B-1', 'S1', 30_000], ['B-2', 'S2', 12_000], ['B-3', 'S2', 9_000]] as const) {
    await ok(h, T, CASHIER, '/v1/sales', {
      saleId, receiptNumber: `R-${saleId}`, laneId: `lane-${loc}`, locationId: loc, cashierId: CASHIER, tradingDay: day, committedAt: at,
      totalMinor: total, currency: 'INR', packVersion: 1, lines: [{ productId: 'P-X', quantityMinor: 1, uom: 'ea', unitPriceMinor: total, lineTotalMinor: total }],
      tenders: [{ kind: 'cash', amountMinor: total }],
    });
  }
  await ok(h, T, OWNER, '/v1/inventory/movements', { movementId: 'mv-1', productId: 'P-RICE', locationId: 'S1', kind: 'received', quantityMinor: 40, uom: 'ea', occurredAt: at, enteredBy: OWNER, unitCostMinor: 400_00 });
}

async function dashboardChecks(h: ApiHarness, T: string): Promise<void> {
  const res = await get(h, T, OWNER, '/v1/reports/dashboard');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const d = res.body as Dash;
  expect(d.kpis.map((k) => k.domain)).toEqual([...KPI_DOMAINS]);
  const block = (k: string): Block => d.kpis.find((x) => x.domain === k)!;
  const fig = (k: string, name: string): Fig => block(k).figures.find((f) => f.name === name)!;
  // Sales: the same figure the Sales by day report gives, and the same as the headline.
  const report = (await get(h, T, OWNER, '/v1/reports/sales_by_day')).body as { figures: Fig[] };
  expect(fig('sales', 'Sales today').valueMinor).toBe(report.figures.find((f) => f.name === 'Taken')!.valueMinor);
  expect(fig('sales', 'Sales today').valueMinor).toBe(51_000);
  expect(d.figures.find((f) => f.name === 'Sales today')!.valueMinor).toBe(51_000);
  expect(fig('sales', 'Sales today — receipts').valueMinor).toBe(3);
  expect(fig('sales', 'Sales today — cash').valueMinor).toBe(51_000);
  // Margin: P-X has no buying cost at head office — not available, naming the product, never ₹0.
  expect(fig('margin', 'Margin today').valueMinor).toBeUndefined();
  expect(fig('margin', 'Margin today').notAvailableBecause).toContain('P-X');
  // Stock: the Stock on hand report's own value.
  const soh = (await get(h, T, OWNER, '/v1/reports/stock_on_hand')).body as { figures: Fig[] };
  expect(fig('stock', 'Stock value on hand').valueMinor).toBe(soh.figures.find((f) => f.name === 'Value on hand')!.valueMinor);
  expect(fig('stock', 'Stock value on hand').valueMinor).toBe(40 * 400_00);
  // Cash, purchase, fulfilment: nothing recorded yet — each said, with its source "never heard", never nought.
  expect(fig('cash', 'Tills closed today').notAvailableBecause).toContain('no till has ever been closed');
  expect(fig('purchase', 'Ordered from suppliers').notAvailableBecause).toContain('no purchase order');
  expect(fig('fulfilment', 'Online orders this month').notAvailableBecause).toContain('no online order');
  expect(block('purchase').asAt).toBeNull();
  // Customer: three bills, none naming a customer.
  expect(fig('customer', 'Customers named on a bill this month').valueMinor).toBe(0);

  // A manager scoped to S2: S2's sales only, in the headline and the block; company-wide registers refused in words.
  const mine = (await get(h, T, MGR, '/v1/reports/dashboard', undefined, 'S2')).body as Dash;
  expect(mine.scope).toEqual(['S2']);
  expect(mine.figures.find((f) => f.name === 'Sales today')!.valueMinor).toBe(21_000);
  expect(mine.kpis.find((k) => k.domain === 'sales')!.figures.find((f) => f.name === 'Sales today')!.valueMinor).toBe(21_000);
  expect(mine.kpis.find((k) => k.domain === 'customer')!.figures.find((f) => f.name === 'Loyalty points outstanding')!.notAvailableBecause).toContain('company-wide');
  // A cashier holds no dashboard right.
  expect((await get(h, T, CASHIER, '/v1/reports/dashboard')).status).toBe(403);
}

async function wasteChecks(h: ApiHarness, T: string): Promise<void> {
  const q = { branchId: 'S1', from: '2026-10-01', to: '2026-10-31' };
  await ok(h, T, OWNER, '/v1/waste/records/W-1', { branchId: 'S1', departmentId: 'D-FRESH', productId: 'P-TOM', source: 'expiry', at: '2026-10-10T05:00:00Z', valueMinor: 4_500, disposal: 'composted' });
  const before = (await get(h, T, OWNER, '/v1/waste/report', q)).body as { energy: { known: boolean }; scrap: { known: boolean }; totalWasteValueMinor: number; drill: { waste: { wasteId: string }[] }; energyKilowattHours?: number };
  expect(before.totalWasteValueMinor).toBe(4_500);
  expect(before.energy.known).toBe(false);
  expect(before.energyKilowattHours).toBeUndefined();
  expect(before.scrap.known).toBe(false);
  expect(before.drill.waste.map((w) => w.wasteId)).toEqual(['W-1']);
  await ok(h, T, OWNER, '/v1/facilities/energy/E-1', { branchId: 'S1', onDate: '2026-10-05', kilowattHours: 1_200, costMinor: 960_000, source: 'meter' });
  await ok(h, T, OWNER, '/v1/facilities/energy/E-2', { branchId: 'S2', onDate: '2026-10-05', kilowattHours: 900, costMinor: 720_000, source: 'meter' });
  await ok(h, T, OWNER, '/v1/scrap/sales', { scrapId: 'SC-1', branchId: 'S1', category: 'cardboard', disposal: 'sold', grams: 50_000, proceedsMinor: 75_000, handledBy: OWNER, at: '2026-10-11T06:00:00Z' });
  const after = (await get(h, T, OWNER, '/v1/waste/report', q)).body as { energy: { known: boolean; kilowattHours: number }; scrap: { known: boolean; proceedsMinor: number; offBooks: number }; energyKilowattHours: number; energyCostMinor: number; scrapProceedsMinor: number; drill: { scrap: { scrapId: string }[]; energy: { onDate: string; kilowattHours: number }[] } };
  expect(after).toMatchObject({ energyKilowattHours: 1_200, energyCostMinor: 960_000, scrapProceedsMinor: 75_000 });
  expect(after.energy).toMatchObject({ known: true, kilowattHours: 1_200 });
  expect(after.scrap).toMatchObject({ known: true, proceedsMinor: 75_000, offBooks: 1 });
  expect(after.drill.scrap.map((s) => s.scrapId)).toEqual(['SC-1']);
  expect(after.drill.energy).toEqual([{ onDate: '2026-10-05', kilowattHours: 1_200, costMinor: 960_000, source: 'meter' }]);
  // Another branch's report is still refused by name for a manager scoped elsewhere.
  expect((await get(h, T, MGR, '/v1/waste/report', q, 'S2')).status).toBe(403);
}

async function securityChecks(h: ApiHarness, T: string): Promise<void> {
  // The test grants are recorded on 7 Aug 2026 (the harness's genesis time), so that is the month asked.
  const res = await get(h, T, OWNER, '/v1/reports/security', { day: '2026-08-07' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const r = res.body as { figures: Fig[]; rows: { what: string; who: string }[] };
  const f = (n: string): Fig => r.figures.find((x) => x.name === n)!;
  expect(f('Access given').valueMinor).toBeGreaterThanOrEqual(3);
  expect(r.rows.filter((x) => x.what === 'access_given').map((x) => x.who)).toEqual(expect.arrayContaining([CASHIER, MGR]));
  // OB-365: the till sign-in log comes from the store computers — none has arrived in this shop, so not known (never 0);
  // the office lockout is held in memory by the API, so it stays not known.
  expect(f('Failed sign-ins').valueMinor).toBeUndefined();
  expect(f('Failed sign-ins').notAvailableBecause).toContain('no till sign-in record has reached head office yet');
  expect(f('Sign-in lockouts').valueMinor).toBeUndefined();
  expect(f('Office sign-in lockouts').notAvailableBecause).toContain('held in memory by the API');
  // Company-wide records: a branch-limited reader is told, not shown a part.
  const mgr = (await get(h, T, MGR, '/v1/reports/security', { day: '2026-08-07' }, 'S2')).body as { figures: Fig[] };
  expect(mgr.figures[0]!.notAvailableBecause).toContain('company-wide');
  // The catalogue lists it as runnable.
  const cat = (await get(h, T, OWNER, '/v1/reports/catalogue')).body as { reports: { report: { id: string }; availability: { available: boolean } }[] };
  expect(cat.reports.find((x) => x.report.id === 'security')!.availability.available).toBe(true);
}

describe('OB-288 P2 — the dashboard covers every domain; waste carries energy and scrap; the security report (in memory)', () => {
  it('every domain is a block from its own report, scoped; waste and security say what they do not know', async () => {
    const T = 'ab000000-0000-4000-8000-00000000d29f';
    const h = apiHarness();
    await seed(h, T);
    await dashboardChecks(h, T);
    await wasteChecks(h, T);
    await securityChecks(h, T);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('OB-288 P2 — dashboard, waste and security on PostgreSQL, through a cold restart', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it('the same, and a fresh head office over the same records reads the same', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await seed(h, T);
    await dashboardChecks(h, T);
    await wasteChecks(h, T);
    const again = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await dashboardChecks(again, T);
    await securityChecks(again, T);
  }, 120_000);
});
