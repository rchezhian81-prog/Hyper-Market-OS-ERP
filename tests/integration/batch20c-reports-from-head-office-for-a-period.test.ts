import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { ownerApprovedSetting } from '../support/owner-approved-setting';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shiftDate } from '../../packages/calendar/src/index';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';
import {
  runAtHeadOffice, HEAD_OFFICE_NOT_REACHED, NOW_FOR_PERIOD_AT_HEAD_OFFICE, GST_WHOLE_MONTHS,
} from '../../apps/web-erp/src/reporting-head-office';
import { HEAD_OFFICE_COST_FOR_PERIOD } from '../../services/api/src/report-producers';

/**
 * **Batch 20c · O2 (owner's missing-options audit, 19 Nov 2026) — the Reports page runs the reports head office works out,
 * for the period the person chose, through the REAL API (in memory and, with DATABASE_URL, real PostgreSQL).**
 *
 * The page's own head-office module (`apps/web-erp/src/reporting-head-office.ts`) is driven over the real routes:
 *   • a PERIOD report covers exactly the days asked (`?from=&to=`): customers coming back over three days counts the bills
 *     of those days only; waste / purchases by supplier for a period that ends yesterday hold none of today's records;
 *   • a report about NOW (stock on hand) shows for Today and reads "Not known for this period" for any other — head office
 *     is not even asked;
 *   • profitability for a past period: the cost of goods and the profit are NOT KNOWN (owner, OB-877 A), never a guess;
 *   • money in the bank: a period inside one month covers that whole month, and says so;
 *   • GST comes from the GST returns (GSTR-3B per whole month) — the very figures `GET /v1/finance/gstr3b/:MMYYYY` returns;
 *     a period that is not whole months reads "Not known" with why;
 *   • head office out of reach: the report says so; nothing is shown in its place;
 *   • a period head office cannot read is refused in words (400).
 * Synthetic data only.
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = shiftDate(TODAY, -1);
const D3 = shiftDate(TODAY, -3);

describe.each(backings)('batch 20c — the Reports page runs head office\'s reports for a period — on $name', ({ harness }) => {
  let h: ApiHarness;
  const T = randomUUID();
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const ok = async (p: ReturnType<typeof call>, ...statuses: number[]) => {
    const r = await p;
    expect(statuses, JSON.stringify(r.body)).toContain(r.status);
    return r;
  };
  /** Head office as the page reaches it — the person's own session over the real routes. */
  const httpAs = (userId: string): HeadOfficeHttp => ({
    get: async (path): Promise<HttpAnswer> => {
      const [p, q] = path.split('?');
      const query = Object.fromEntries(new URLSearchParams(q ?? ''));
      const r = await call('GET', p!, userId, undefined, query);
      if (r.status >= 200 && r.status < 300) return { result: 'ok', status: r.status, body: r.body };
      const err = (r.body as { error?: { code?: string; whatHappened?: string } } | null)?.error ?? {};
      return { result: 'refused', status: r.status, code: err.code ?? `http_${r.status}`, whatHappened: err.whatHappened ?? '' };
    },
    post: async () => ({ result: 'lost_link' }),
  });
  const run = (reportId: string, asked: { from: string; to: string }, http: HeadOfficeHttp | undefined = httpAs('u-owner')) =>
    runAtHeadOffice({ reportId, http, asked, today: TODAY, now: new Date().toISOString(), laggingAfterMinutes: 5, staleAfterMinutes: 60 });
  const val = (r: { figures: readonly { name: string; valueMinor?: number }[] } | undefined, name: string): number | undefined => r?.figures.find((f) => f.name === name)?.valueMinor;
  const because = (r: { figures: readonly { name: string; notAvailableBecause?: string }[] } | undefined, name: string): string | undefined => r?.figures.find((f) => f.name === name)?.notAvailableBecause;

  beforeAll(async () => {
    h = harness();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await ok(ownerApprovedSetting(h, T, 'locale.time_zone', { value: 'UTC' }), 200);
    await approvedSuppliers(h, T, 's-1');
    await deliveryPlaces(h, T, 'S1');
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'mv-milk', productId: 'P-MILK', locationId: 'S1', kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: `${D3}T06:00:00.000Z`, enteredBy: 'u-owner', unitCostMinor: 3_000 }), 202);
    // Bills naming a member on three days: m-A three days ago and yesterday; m-B today.
    const sale = (id: string, day: string, member: string) => ok(call('POST', '/v1/sales', 'u-cash', {
      saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-S1', locationId: 'S1', cashierId: 'u-cash', tradingDay: day, committedAt: `${day}T09:00:00.000Z`,
      totalMinor: 7_000, currency: 'INR', packVersion: 1, customerRef: member,
      lines: [{ productId: 'P-MILK', quantityMinor: 2, uom: 'ea', unitPriceMinor: 3_500, lineTotalMinor: 7_000, taxRateBps: 0 }], tenders: [{ kind: 'cash', amountMinor: 7_000 }],
    }), 202);
    await sale('S-1', D3, 'm-A');
    await sale('S-2', YESTERDAY, 'm-A');
    await sale('S-3', TODAY, 'm-B');
    // Today: a write-off and a purchase order.
    await ok(call('POST', '/v1/inventory/write-off/WO-1', 'u-mgr', { productId: 'P-MILK', locationId: 'S1', qty: 2, uom: 'ea', lossType: 'damage', reasonCode: 'damage' }), 201);
    await ok(call('POST', '/v1/purchase/orders/po-1', 'u-buyer', { supplierId: 's-1', deliverToLocationId: 'S1', lines: [{ productId: 'P-MILK', orderedQty: 10, unitCost: { minor: 3_000, currency: 'INR' } }] }), 201);
  }, 180_000);

  it('a period report covers exactly the days asked, and says which', async () => {
    const three = await run('customer_repeat', { from: D3, to: YESTERDAY });
    expect(three?.state).toBe('shown');
    expect(three?.covers).toEqual({ from: D3, to: YESTERDAY });
    expect(val(three, 'Customers named on a bill')).toBe(1);
    expect(val(three, 'Customers who came back')).toBe(1);
    expect(val(three, 'Visits by named customers')).toBe(2);
    const all = await run('customer_repeat', { from: D3, to: TODAY });
    expect(val(all, 'Customers named on a bill')).toBe(2);
    expect(val(all, 'Visits by named customers')).toBe(3);
    // A period running past today stops at today, and says so.
    const ahead = await run('customer_repeat', { from: D3, to: shiftDate(TODAY, 5) });
    expect(ahead?.covers).toEqual({ from: D3, to: TODAY });

    const wasteToday = await run('waste', { from: TODAY, to: TODAY });
    expect(val(wasteToday, 'Thrown away, at cost')).toBe(2 * 3_000);
    expect(wasteToday?.covers).toEqual({ from: TODAY, to: TODAY });
    const wasteBefore = await run('waste', { from: D3, to: YESTERDAY });
    expect(val(wasteBefore, 'Write-offs')).toBe(0);
    expect(val(wasteBefore, 'Thrown away, at cost')).toBe(0);

    const buying = await run('purchases_by_supplier', { from: TODAY, to: TODAY });
    expect(buying?.rows).toEqual([{ supplierId: 's-1', orders: '1', orderedMinor: '30000' }]);
    expect(buying?.covers).toEqual({ from: TODAY, to: TODAY });
    expect((await run('purchases_by_supplier', { from: D3, to: YESTERDAY }))?.rows).toEqual([]);
  });

  it('a report about now shows for Today only — for another period it is not known and head office is not asked', async () => {
    const now = await run('stock_on_hand', { from: TODAY, to: TODAY });
    expect(now?.state).toBe('shown');
    expect(now?.now).toBe(true);
    expect(now?.covers).toBeNull();
    expect(val(now, 'Value on hand')).toBe((50 - 3 * 2 - 2) * 3_000); // received 50, three bills of 2, a write-off of 2
    let asked = 0;
    const counting: HeadOfficeHttp = { get: async (p) => { asked += 1; return httpAs('u-owner').get(p); }, post: async () => ({ result: 'lost_link' }) };
    const past = await run('stock_on_hand', { from: YESTERDAY, to: YESTERDAY }, counting);
    expect(past?.state).toBe('not_for_period');
    expect(because(past, 'Stock on hand')).toBe(NOW_FOR_PERIOD_AT_HEAD_OFFICE);
    expect(asked).toBe(0);
  });

  it('profitability for a past period: revenue from the posted books, cost and profit NOT KNOWN (OB-877 A); money in the bank covers whole months', async () => {
    const p = await run('profitability', { from: D3, to: YESTERDAY });
    expect(p?.covers).toEqual({ from: D3, to: YESTERDAY });
    expect(val(p, 'Cost of goods sold')).toBeUndefined();
    expect(because(p, 'Cost of goods sold')).toBe(HEAD_OFFICE_COST_FOR_PERIOD);
    expect(because(p, 'Profit')).toBe(HEAD_OFFICE_COST_FOR_PERIOD);
    // The days with sales whose book is not posted are NAMED; the revenue is not a short total.
    expect(because(p, 'Revenue net of GST and returns')).toContain(D3);
    expect(p?.figures.some((f) => f.valueMinor === 0)).toBe(false);

    const bank = await run('reconciliation', { from: TODAY, to: TODAY });
    const lastOfMonth = shiftDate(`${shiftDate(`${TODAY.slice(0, 8)}01`, 32).slice(0, 8)}01`, -1);
    expect(bank?.covers).toEqual({ from: `${TODAY.slice(0, 8)}01`, to: lastOfMonth > TODAY ? TODAY : lastOfMonth });
  });

  it('GST is the GST returns\' own figures (GSTR-3B per whole month); a period that is not whole months is not known, with why', async () => {
    const first = `${TODAY.slice(0, 8)}01`;
    const gst = await run('gst', { from: first, to: TODAY });
    expect(gst?.state).toBe('shown');
    expect(gst?.covers).toEqual({ from: first, to: TODAY });
    const g3b = (await ok(call('GET', `/v1/finance/gstr3b/${TODAY.slice(5, 7)}${TODAY.slice(0, 4)}`, 'u-owner'), 200)).body as { table31: { a: { taxableMinor: number; cgstMinor: number; sgstMinor: number }; c: { taxableMinor: number } }; table4: { a5AllOther: { status: string } } };
    expect(val(gst, 'Taxable sales (GSTR-3B 3.1 a)')).toBe(g3b.table31.a.taxableMinor);
    expect(val(gst, 'GST collected — CGST')).toBe(g3b.table31.a.cgstMinor);
    expect(val(gst, 'Nil-rated and exempt sales (3.1 c)')).toBe(g3b.table31.c.taxableMinor);
    if (g3b.table4.a5AllOther.status !== 'reconciled') expect(because(gst, 'GST paid on purchases you may claim (4 A 5)')).toMatch(/^Not known — the purchase GST you may claim is not reconciled yet/);
    expect(gst?.notes[0]).toMatch(/provisional — GSTR-1 not filed yet/);

    const week = await run('gst', { from: YESTERDAY, to: TODAY });
    expect(week?.state).toBe('not_for_period');
    expect(because(week, 'GST')).toBe(GST_WHOLE_MONTHS);
  });

  it('head office out of reach: the report says so and shows nothing in its place; a period head office cannot read is refused', async () => {
    const lost: HeadOfficeHttp = { get: async () => ({ result: 'lost_link' }), post: async () => ({ result: 'lost_link' }) };
    const off = await run('waste', { from: TODAY, to: TODAY }, lost);
    expect(off?.state).toBe('not_reached');
    expect(off?.figures).toHaveLength(1);
    expect(off?.figures[0]?.valueMinor).toBeUndefined();
    expect(off?.figures[0]?.notAvailableBecause).toBe(HEAD_OFFICE_NOT_REACHED);
    expect((await run('gst', { from: `${TODAY.slice(0, 8)}01`, to: TODAY }, lost))?.state).toBe('not_reached');

    for (const query of <Record<string, string>[]>[{ from: TODAY, to: YESTERDAY }, { from: 'yesterday', to: TODAY }, { from: TODAY, to: TODAY, day: TODAY }, { from: '2024-01-01', to: '2025-06-01' }]) {
      const r = await call('GET', '/v1/reports/waste', 'u-owner', undefined, query);
      expect(r.status, JSON.stringify(query)).toBe(400);
      expect((r.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_period');
    }
    // A cashier may not read reports: head office's own words, shown as said.
    const cashier = await run('waste', { from: TODAY, to: TODAY }, httpAs('u-cash'));
    expect(cashier?.state).toBe('refused');
    expect(cashier?.figures[0]?.notAvailableBecause).toMatch(/^Not shown — head office said: /);
  });
});
