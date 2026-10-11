import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { splitInclusive } from '../../packages/finance/src/day-book';
import { shiftDate } from '../../packages/calendar/src/index';

/**
 * **D13 round 8 — the sales and stock reports that had no head-office producer now reconcile to their source records,
 * through the REAL API surface (in memory and, with DATABASE_URL, real PostgreSQL).**
 *
 * The sources are built through the production routes a shop uses — the till's sales (posted by the cashier's sync),
 * receipts at cost with batch expiries on the stock ledger, shelf counts, write-offs and the till's voids / no-sales — and
 * each report read through `GET /v1/reports/:name` is asserted EXACTLY equal to the sum of those records, and, where the
 * domain has its own read, to that read:
 *   • sales by hour, average basket, day on day, margin (net of GST, at the OB-39 average buying cost), customers coming back;
 *   • shrinkage (the counts that changed the books, at head office's own cost), waste (= GET /v1/inventory/write-offs),
 *     approaching expiry (= GET /v1/inventory/near-expiry), and the day's exceptions (= what the rules raised);
 *   • every figure is as at its source; a branch-limited manager sees only their branch or is told, in words, that the
 *     register is company-wide; a cost head office does not hold makes a margin NOT AVAILABLE, naming the product — never 0;
 *   • a governed drill reaches the very bills/records behind a figure and reconciles.
 * Synthetic data only.
 */

interface Fig { name: string; valueMinor?: number; asAt: string | null; notAvailableBecause?: string }
interface Report { figures: Fig[]; rows: Record<string, string>[]; sources: { source: string; lastEventAt: string | null }[]; tradingDay?: string; period?: { from: string; to: string } }

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

// A trading day in the past (the till syncs it later — offline-first), and the two before it.
const DAY = '2026-09-15';
const TODAY = new Date().toISOString().slice(0, 10);
const RICE_RATE = 500; // 5% GST, frozen on the line by the till
const MILK_RATE = 0;   // exempt

type Line = readonly [productId: string, qty: number, unitMinor: number, rateBps: number];
const SALES: readonly { id: string; day: string; hhmm: string; loc: string; lines: readonly Line[]; tender: string; member?: string }[] = [
  { id: 'S-1', day: DAY, hhmm: '09:10', loc: 'S1', lines: [['P-RICE', 1, 48_000, RICE_RATE], ['P-MILK', 2, 3_500, MILK_RATE]], tender: 'cash', member: 'm-A' },
  { id: 'S-2', day: DAY, hhmm: '09:40', loc: 'S1', lines: [['P-MILK', 3, 3_500, MILK_RATE]], tender: 'upi', member: 'm-B' },
  { id: 'S-3', day: DAY, hhmm: '14:05', loc: 'S2', lines: [['P-RICE', 1, 48_000, RICE_RATE]], tender: 'card' },
  // Two days earlier (nothing on the day between): the "last day traded" day on day compares with.
  { id: 'S-0', day: shiftDate(DAY, -2), hhmm: '11:00', loc: 'S1', lines: [['P-MILK', 4, 3_500, MILK_RATE]], tender: 'cash', member: 'm-A' },
];
const totalOf = (s: (typeof SALES)[number]): number => s.lines.reduce((t, [, q, p]) => t + q * p, 0);

describe.each(backings)('D13 — the other sales and stock reports reconcile to their sources — on $name', ({ harness }) => {
  let h: ApiHarness;
  const T = randomUUID();
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>, branchId?: string) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(branchId === undefined ? {} : { branchId }) });
  const ok = async (p: ReturnType<typeof call>, ...statuses: number[]) => {
    const r = await p;
    expect(statuses, JSON.stringify(r.body)).toContain(r.status);
    return r;
  };
  const report = async (name: string, query?: Record<string, string>, userId = 'u-owner', branchId?: string): Promise<Report> =>
    (await ok(call('GET', `/v1/reports/${name}`, userId, undefined, query, branchId), 200)).body as Report;
  const fig = (r: Report, name: string): Fig | undefined => r.figures.find((f) => f.name === name);
  const val = (r: Report, name: string): number | undefined => fig(r, name)?.valueMinor;
  const onHand = async (productId: string, locationId: string): Promise<number> =>
    ((await ok(call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId }), 200)).body as { rows: { locationId: string; onHandMinor: number }[] })
      .rows.filter((r) => r.locationId === locationId).reduce((t, r) => t + r.onHandMinor, 0);

  beforeAll(async () => {
    h = harness();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-mgr-s2', 'store_manager', ['S2']); // a manager of ONE branch
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']); // OB-54: a store computer is granted for its own store
    await ok(call('PUT', '/v1/platform/setup/locale.time_zone', 'u-owner', { value: 'UTC' }), 200);
    // Receipts at cost on the stock ledger (the average buying cost OB-39 reads), and batches with expiries.
    const recv = (mv: string, productId: string, loc: string, qty: number, cost: number | undefined, extra: Record<string, unknown> = {}) =>
      ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: mv, productId, locationId: loc, kind: 'received', quantityMinor: qty, uom: 'ea', occurredAt: `${shiftDate(DAY, -10)}T08:00:00.000Z`, enteredBy: 'u-owner', ...(cost === undefined ? {} : { unitCostMinor: cost }), ...extra }), 202);
    await recv('mv-r1', 'P-RICE', 'S1', 10, 40_000);
    await recv('mv-m1', 'P-MILK', 'S1', 20, 3_000);
    await recv('mv-r2', 'P-RICE', 'S2', 5, 40_000);
    await recv('mv-y1', 'P-YOG', 'S1', 6, 2_000, { batchId: 'B-PAST', expiry: shiftDate(TODAY, -2) });
    await recv('mv-y2', 'P-YOG', 'S1', 4, 2_000, { batchId: 'B-NEAR', expiry: shiftDate(TODAY, 3) });
    await recv('mv-y3', 'P-YOG', 'S2', 9, 2_000, { batchId: 'B-S2', expiry: shiftDate(TODAY, 1) });
    await recv('mv-y4', 'P-YOG', 'S1', 7, 2_000, { batchId: 'B-FAR', expiry: shiftDate(TODAY, 60) });
    // The till's sales, synced later by the cashier's sign-in (offline-first: committed on the day, sent after).
    for (const s of SALES) {
      await ok(call('POST', '/v1/sales', 'u-cash', {
        saleId: s.id, receiptNumber: `R-${s.id}`, laneId: `lane-${s.loc}`, locationId: s.loc, cashierId: 'u-cash',
        tradingDay: s.day, committedAt: `${s.day}T${s.hhmm}:00.000Z`, totalMinor: totalOf(s), currency: 'INR', packVersion: 1,
        lines: s.lines.map(([productId, q, p, rate]) => ({ productId, quantityMinor: q, uom: 'ea', unitPriceMinor: p, lineTotalMinor: q * p, taxRateBps: rate })),
        tenders: [{ kind: s.tender, amountMinor: totalOf(s) }],
        ...(s.member === undefined ? {} : { customerRef: s.member }),
      }), 202);
    }
  }, 180_000);

  it('sales by hour, average basket and day on day are exactly the bills behind them', async () => {
    const onDay = SALES.filter((s) => s.day === DAY);
    const taken = onDay.reduce((t, s) => t + totalOf(s), 0);

    const hours = await report('sales_by_hour', { day: DAY });
    expect(hours.tradingDay).toBe(DAY);
    expect(val(hours, '09:00')).toBe(totalOf(SALES[0]!) + totalOf(SALES[1]!));
    expect(val(hours, '14:00')).toBe(totalOf(SALES[2]!));
    expect(val(hours, 'Taken')).toBe(taken);
    expect(hours.rows.reduce((t, r) => t + Number(r['totalMinor']), 0)).toBe(taken);
    expect(hours.rows.find((r) => r['key'] === '09:00')?.['bills']).toBe('2');

    const basket = await report('basket', { day: DAY });
    expect(val(basket, 'Bills')).toBe(3);
    expect(val(basket, 'Average basket')).toBe(Math.round(taken / 3));
    expect(val(basket, 'Items sold')).toBe(1 + 2 + 3 + 1);
    // A day nobody traded has no basket — not ₹0.
    const empty = await report('basket', { day: shiftDate(DAY, -1) });
    expect(val(empty, 'Average basket')).toBeUndefined();
    expect(fig(empty, 'Average basket')?.notAvailableBecause).toMatch(/no bill was rung/);

    const dod = await report('day_on_day', { day: DAY });
    expect(val(dod, `Taken on ${DAY}`)).toBe(taken);
    expect(val(dod, 'Taken on the last day traded before')).toBe(totalOf(SALES[3]!));
    expect(val(dod, 'Difference')).toBe(taken - totalOf(SALES[3]!));
    expect(dod.rows.map((r) => r['tradingDay'])).toEqual([DAY, shiftDate(DAY, -2)]);

    // The governed drill reaches the very bills behind the 09:00 figure, and reconciles.
    const drill = (await ok(call('POST', '/v1/reporting/drill/governed', 'u-owner', { reportId: 'sales_by_hour', figure: '09:00', day: DAY }), 200)).body as { reconciles: boolean; transactions: { transactionId: string }[] };
    expect(drill.reconciles).toBe(true);
    expect(drill.transactions.map((t) => t.transactionId).sort()).toEqual(['S-1', 'S-2']);
  });

  it('margin = Σ (each bill net of GST − its goods at the average buying cost); an uncosted product makes it NOT AVAILABLE, naming it', async () => {
    const net = (s: (typeof SALES)[number]): number => s.lines.reduce((t, [, q, p, rate]) => t + splitInclusive(q * p, rate).net, 0);
    const cogs = (s: (typeof SALES)[number]): number => s.lines.reduce((t, [pid, q]) => t + q * (pid === 'P-RICE' ? 40_000 : 3_000), 0);
    const onDay = SALES.filter((s) => s.day === DAY);
    const m = await report('margin', { day: DAY });
    const expectNet = onDay.reduce((t, s) => t + net(s), 0);
    const expectCogs = onDay.reduce((t, s) => t + cogs(s), 0);
    expect(val(m, 'Taken net of GST')).toBe(expectNet);
    expect(val(m, 'Cost of goods sold')).toBe(expectCogs);
    expect(val(m, 'Margin')).toBe(expectNet - expectCogs);
    expect(m.rows.find((r) => r['saleId'] === 'S-3')).toEqual({ saleId: 'S-3', netMinor: String(net(SALES[2]!)), cogsMinor: '40000', marginMinor: String(net(SALES[2]!) - 40_000) });

    // A bill of a product the store never received at a cost: the margin is not known — said, never costed at zero.
    const day = shiftDate(DAY, 1);
    await ok(call('POST', '/v1/sales', 'u-cash', {
      saleId: 'S-GIFT', receiptNumber: 'R-S-GIFT', laneId: 'lane-S1', locationId: 'S1', cashierId: 'u-cash', tradingDay: day,
      committedAt: `${day}T10:00:00.000Z`, totalMinor: 9_900, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'P-GIFT', quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_900, lineTotalMinor: 9_900, taxRateBps: 1_800 }],
      tenders: [{ kind: 'cash', amountMinor: 9_900 }],
    }), 202);
    const gift = await report('margin', { day });
    for (const name of ['Cost of goods sold', 'Margin']) {
      expect(val(gift, name)).toBeUndefined();
      expect(fig(gift, name)?.notAvailableBecause).toMatch(/no average buying cost for P-GIFT/);
    }
    expect(gift.rows[0]?.['marginMinor']).toBe('not known');
  });

  it('customers coming back: the month to the day, by member code — counted by how often, never listed by who', async () => {
    const r = await report('customer_repeat', { day: DAY });
    expect(r.period).toEqual({ from: '2026-09-01', to: DAY });
    expect(val(r, 'Customers named on a bill')).toBe(2);   // m-A, m-B
    expect(val(r, 'Customers who came back')).toBe(1);     // m-A, twice
    expect(val(r, 'Visits by named customers')).toBe(3);
    expect(val(r, 'Bills with no customer named')).toBe(1);
    expect(val(r, 'Taken from named customers')).toBe(totalOf(SALES[0]!) + totalOf(SALES[1]!) + totalOf(SALES[3]!));
    expect(r.rows).toEqual([{ visits: '1', customers: '1' }, { visits: '2', customers: '1' }]);
    expect(JSON.stringify(r.rows)).not.toMatch(/m-A|m-B/);
  });

  it('a branch-limited manager sees only their branch\'s bills', async () => {
    const mine = await report('sales_by_hour', { day: DAY }, 'u-mgr-s2', 'S2');
    expect(val(mine, 'Taken')).toBe(totalOf(SALES[2]!));
    expect(mine.figures.map((f) => f.name)).toEqual(['14:00', 'Taken', 'Bills outside your branches (not in these figures)']);
    expect(val(mine, 'Bills outside your branches (not in these figures)')).toBe(2); // said, never shown
    expect((await call('GET', '/v1/reports/sales_by_hour', 'u-mgr-s2', undefined, { day: DAY, scope: 'S1' }, 'S2')).status).toBe(403);
  });

  it('shrinkage, waste and expiry reconcile to the counts, write-offs and batches head office holds', async () => {
    // Shelf counts: rice at S1 counted 2 short, milk counted 1 over — both small enough to apply at once.
    const rice = await onHand('P-RICE', 'S1');
    const milk = await onHand('P-MILK', 'S1');
    await ok(call('POST', '/v1/inventory/counts/K-RICE', 'u-mgr', { productId: 'P-RICE', locationId: 'S1', uom: 'ea', countedMinor: rice - 2, reasonCode: 'cycle' }), 201);
    await ok(call('POST', '/v1/inventory/counts/K-MILK', 'u-mgr', { productId: 'P-MILK', locationId: 'S1', uom: 'ea', countedMinor: milk + 1, reasonCode: 'cycle' }), 201);
    const shrink = await report('shrinkage');
    expect(shrink.period?.to).toBe(TODAY);
    expect(val(shrink, 'Counts that changed the books')).toBe(2);
    expect(val(shrink, 'Lost (counted short)')).toBe(2 * 40_000);
    expect(val(shrink, 'Found (counted over)')).toBe(3_000);
    expect(val(shrink, 'Net shrinkage (lost less found)')).toBe(2 * 40_000 - 3_000);
    // = the counts register's own read.
    const counts = ((await ok(call('GET', '/v1/inventory/counts', 'u-owner', undefined, { productId: 'P-RICE', locationId: 'S1' }), 200)).body as { counts: { countId: string; valueMinor: number; varianceMinor: number }[] });
    expect(counts.counts.find((c) => c.countId === 'K-RICE')).toMatchObject({ valueMinor: 80_000, varianceMinor: -2 });
    expect(shrink.rows.find((r) => r['countId'] === 'K-RICE')?.['valueMinor']).toBe('-80000');
    // The S2 manager sees none of S1's counts.
    expect(val(await report('shrinkage', undefined, 'u-mgr-s2', 'S2'), 'Counts that changed the books')).toBe(0);

    // Write-offs: two small losses at the stock's own cost.
    await ok(call('POST', '/v1/inventory/write-off/WO-1', 'u-mgr', { productId: 'P-MILK', locationId: 'S1', qty: 2, uom: 'ea', lossType: 'damage', reasonCode: 'leaking' }), 201);
    await ok(call('POST', '/v1/inventory/write-off/WO-2', 'u-mgr', { productId: 'P-YOG', locationId: 'S1', qty: 1, uom: 'ea', lossType: 'expiry', reasonCode: 'past date' }), 201);
    const waste = await report('waste');
    const listed = (await ok(call('GET', '/v1/inventory/write-offs', 'u-owner'), 200)).body as { totalLossMinor: number };
    expect(val(waste, 'Thrown away, at cost')).toBe(2 * 3_000 + 2_000);
    expect(val(waste, 'Thrown away, at cost')).toBe(listed.totalLossMinor);
    expect(val(waste, 'damage — at cost')).toBe(6_000);
    expect(val(waste, 'expiry — at cost')).toBe(2_000);
    expect(val(waste, 'Write-offs')).toBe(2);
    const wdrill = (await ok(call('POST', '/v1/reporting/drill/governed', 'u-owner', { reportId: 'waste', figure: 'Thrown away, at cost' }), 200)).body as { reconciles: boolean; transactions: { transactionId: string }[] };
    expect(wdrill.reconciles).toBe(true);
    expect(wdrill.transactions.map((t) => t.transactionId).sort()).toEqual(['WO-1', 'WO-2']);

    // Approaching expiry = the near-expiry route's own answer, limited to the reader's branches.
    const exp = await report('expiry');
    const route = (await ok(call('GET', '/v1/inventory/near-expiry', 'u-owner', undefined, { withinDays: '7' }), 200)).body as { items: { batchId: string; qty: number; action: string }[] };
    const past = route.items.filter((i) => i.action === 'dispose'); const near = route.items.filter((i) => i.action === 'markdown');
    expect(val(exp, 'Batches past expiry')).toBe(past.length);
    expect(val(exp, 'Units past expiry')).toBe(past.reduce((t, i) => t + i.qty, 0));
    expect(val(exp, 'Batches expiring within 7 days')).toBe(near.length);
    expect(exp.rows.map((r) => r['batchId']).sort()).toEqual(['B-NEAR', 'B-PAST', 'B-S2']);
    expect(exp.rows.find((r) => r['batchId'] === 'B-PAST')?.['action']).toBe('dispose');
    const s2 = await report('expiry', undefined, 'u-mgr-s2', 'S2');
    expect(s2.rows.map((r) => r['batchId'])).toEqual(['B-S2']);
  });

  it('the day\'s exceptions = the voids, no-sales and rule breaches head office holds; a branch reader is told why not', async () => {
    await ok(call('POST', '/v1/loss-prevention/rules/no_sale', 'u-owner', { maxCount: 1 }), 201);
    const at = new Date().toISOString();
    for (const id of ['N-1', 'N-2']) {
      await ok(call('POST', `/v1/loss-prevention/activity/${id}/synced`, 'u-box', { activityId: id, kind: 'no_sale', laneId: 'lane-S1', cashierId: 'u-cash', at, reason: 'change_for_customer', valueMinor: 0, approvedBy: 'u-mgr', approvalId: `apr-${id}` }, undefined, 'S1'), 201);
    }
    await ok(call('POST', '/v1/loss-prevention/activity/V-1/synced', 'u-box', { activityId: 'V-1', kind: 'void', laneId: 'lane-S1', cashierId: 'u-cash', at, billRef: 'B-9', lineId: 'L1', productId: 'P-MILK', description: 'Milk', reason: 'scanned twice', valueMinor: 3_500 }, undefined, 'S1'), 201);
    const ex = await report('exceptions');
    const raised = ((await ok(call('GET', '/v1/loss-prevention/exceptions', 'u-owner'), 200)).body as { exceptions: unknown[] }).exceptions;
    expect(val(ex, 'Breaches of the shop\'s own limits')).toBe(raised.length);
    expect(raised.length).toBeGreaterThan(0);
    expect(val(ex, 'No-sales')).toBe(2);
    expect(val(ex, 'Voids')).toBe(1);
    expect(val(ex, 'Voided value')).toBe(3_500);
    expect(ex.rows[0]?.['what']).toMatch(/no_sale/);
    const branch = await report('exceptions', undefined, 'u-mgr-s2', 'S2');
    expect(branch.figures[0]?.valueMinor).toBeUndefined();
    expect(branch.figures[0]?.notAvailableBecause).toMatch(/company-wide/);
  });

  it('every new report is as at its source, never the read time; a report with no records says so rather than reading 0', async () => {
    const hours = await report('sales_by_hour', { day: DAY });
    expect(hours.sources.map((s) => s.source).sort()).toEqual(['store:S1', 'store:S2']);
    expect(fig(hours, 'Taken')?.asAt).not.toBeNull();
    const fresh = apiHarness();
    const t2 = randomUUID();
    await fresh.seedOwner(t2, 'u-owner');
    for (const id of ['shrinkage', 'waste', 'exceptions']) {
      const r = (await fresh.request({ method: 'GET', path: `/v1/reports/${id}`, userId: 'u-owner', tenantId: t2 })).body as Report;
      for (const f of r.figures) {
        expect(f.valueMinor, `${id}: ${f.name}`).toBeUndefined();
        expect(f.notAvailableBecause, `${id}: ${f.name}`).toMatch(/ever|never/);
      }
    }
  });
});
