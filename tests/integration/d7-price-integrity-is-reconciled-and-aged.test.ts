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

/**
 * **D-7 (roadmap v2.1 addendum, ratified R2; pairs with B25) — "Price-of-record vs shelf vs POS vs app are reconciled into an
 * ageing exception report; asserted".**
 *
 * On the real API, in memory and — with DATABASE_URL — on real PostgreSQL. Nobody hands the audit a price: head office reads
 * the price of record from its own price list, the shelf and app from what people and the app SAW (observations), and the
 * till from the banked sale records (the till itself is never touched). The report ages each exception from when it began,
 * in bands; a mismatch fixed and seen fixed leaves it by itself. B25's on-demand audit is unchanged beside it.
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

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Exc { productId: string; surface: string; kind: string; recordMinor: number; surfaceMinor?: number; openSince: string; ageDays: number; band: string; evidence: string }
interface Report { exceptions: Exc[]; byBand: { band: string; count: number }[]; count: number; productsChecked: number }
const DAY = 86_400_000;

describe.each(backings)('D-7 — price of record, shelf, till and app are reconciled into an ageing report — on $name', ({ harness }) => {
  it('reads every price itself, names each mismatch, ages it in bands, and drops it once fixed', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body, idempotencyKey: `k-${n++}` }), ...(query === undefined ? {} : { query }) });
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const today = iso(now).slice(0, 10);

    // ── the price of record: head office's own price list for store S1 ────────────────────────────────────────
    for (const [p, price] of [['OIL', 5_500], ['SALT', 2_000], ['DAL', 1_600]] as const) {
      const r = await call('POST', `/v1/prices/list/${p}/entries/e-${p}`, 'u-owner', { scope: 'store', scopeRef: 'S1', priceMinor: price, mrpMinor: price * 2, costMinor: Math.floor(price / 2), marginFloorBps: 0, currency: 'INR', effectiveFrom: today });
      expect(r.status, p).toBeLessThan(300);
    }
    // ── what the shelf and the app were SEEN showing (by the signed-in person) ────────────────────────────────
    const observe = (id: string, body: Record<string, unknown>, by = 'u-mgr') => call('POST', `/v1/pricing/integrity/observations/${id}`, by, { branchId: 'S1', ...body });
    expect((await observe('o-oil-shelf', { productId: 'OIL', surface: 'shelf_label', priceMinor: 5_000, observedAt: iso(now - 60_000), shelfAddress: 'A4-1' })).status).toBe(201); // ₹50 on the shelf, ₹55 of record
    expect((await observe('o-oil-app', { productId: 'OIL', surface: 'app', priceMinor: 5_500 })).status).toBe(201);                                                   // the app agrees
    expect((await observe('o-salt-shelf', { productId: 'SALT', surface: 'shelf_label', priceMinor: 2_200, observedAt: iso(now - 50_000) })).status).toBe(201);         // ₹22 shown, ₹20 of record
    // Refused: a future sighting, an unknown surface, someone else named as the observer, a cashier (no price.integrity.audit).
    expect(codeOf(await observe('o-bad1', { productId: 'OIL', surface: 'shelf_label', priceMinor: 1, observedAt: iso(now + DAY) }))).toBe('not_readable_as_a_price_observation');
    expect(codeOf(await observe('o-bad2', { productId: 'OIL', surface: 'flyer', priceMinor: 1 }))).toBe('not_readable_as_a_price_observation');
    expect(codeOf(await observe('o-bad3', { productId: 'OIL', surface: 'app', priceMinor: 1, observedBy: 'u-owner' }))).toBe('not_readable_as_a_price_observation');
    expect((await observe('o-bad4', { productId: 'OIL', surface: 'app', priceMinor: 1 }, 'u-cash')).status).toBe(403);

    // ── what the till CHARGED: banked sale records (the till is not touched) ──────────────────────────────────
    const sale = (id: string, lines: [string, number][], at: number) => call('POST', '/v1/sales', 'u-cash', {
      saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-cash', tradingDay: today, committedAt: iso(at),
      totalMinor: lines.reduce((t, [, p]) => t + p, 0), currency: 'INR', packVersion: 1,
      lines: lines.map(([productId, p]) => ({ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: p, lineTotalMinor: p })),
      tenders: [{ kind: 'cash', amountMinor: lines.reduce((t, [, p]) => t + p, 0) }],
    });
    expect((await sale('s1', [['OIL', 5_500], ['DAL', 1_800]], now - 40_000)).status).toBe(202); // DAL charged ₹18, ₹16 of record
    expect((await sale('s2', [['SALT', 2_000]], now - 30_000)).status).toBe(202);

    const ageing = async (asOf: number, by = 'u-owner') => call('GET', '/v1/pricing/integrity/ageing', by, undefined, { branchId: 'S1', asOf: iso(asOf) });
    const r1 = await ageing(now + 4 * DAY); // read four days on: the same facts, aged
    expect(r1.status).toBe(200);
    const rep = r1.body as Report;
    expect(rep.exceptions.map((e) => [e.productId, e.surface, e.kind, e.recordMinor, e.surfaceMinor ?? null])).toEqual([
      ['OIL', 'shelf_label', 'shown_below_record', 5_500, 5_000],   // legal exposure: the customer was offered ₹50
      ['DAL', 'pos', 'charged_above_record', 1_600, 1_800],         // the till charged more than the shop's own price
      ['DAL', 'shelf_label', 'never_observed', 1_600, null],        // on sale, and nobody has seen its shelf
      ['SALT', 'shelf_label', 'shown_above_record', 2_000, 2_200],
    ]);
    const oil = rep.exceptions[0]!;
    expect(oil.openSince).toBe(iso(now - 60_000));
    expect(oil.ageDays).toBe(4);
    expect(oil.band).toBe('3-7 days');
    expect(rep.exceptions[1]!.evidence).toContain('on sale s1');
    expect(rep.byBand.find((b) => b.band === '3-7 days')?.count).toBe(4); // all four began today
    // Read now, the same exceptions are under a day old.
    expect(((await ageing(now)).body as Report).exceptions.filter((e) => e.kind !== 'never_observed').every((e) => e.band === 'under 1 day')).toBe(true);

    // ── fixed, and seen fixed: it leaves the report by itself ─────────────────────────────────────────────────
    expect((await observe('o-oil-shelf-2', { productId: 'OIL', surface: 'shelf_label', priceMinor: 5_500 })).status).toBe(201);
    const after = (await ageing(now + 4 * DAY)).body as Report;
    expect(after.exceptions.some((e) => e.productId === 'OIL')).toBe(false);
    expect(after.count).toBe(3);

    // The report is the store's: a cashier may not read it, and it needs the store named.
    expect((await ageing(now, 'u-cash')).status).toBe(403);
    expect(codeOf(await call('GET', '/v1/pricing/integrity/ageing', 'u-owner'))).toBe('ageing_report_needs_a_store');
    // B25's on-demand audit is unchanged beside it.
    expect((await call('POST', '/v1/pricing/integrity/audit', 'u-owner', { branchId: 'S1', asAt: iso(now), products: [{ productId: 'OIL', name: 'Oil', posPriceMinor: 5_500 }], displayed: [{ surface: 'shelf_label', productId: 'OIL', branchId: 'S1', priceMinor: 5_000, lastConfirmedAt: iso(now) }] })).status).toBe(200);
  });
});
