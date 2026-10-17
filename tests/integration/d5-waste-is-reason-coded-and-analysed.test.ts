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
import { WASTE_REASON_CODES } from '../../packages/waste/src/reasons';

/**
 * **D-5 (roadmap v2.1 addendum, ratified R2) — "Waste is captured against a closed reason taxonomy; analytics aggregate by
 * SKU/dept/reason; a bare (reasonless) waste event is rejected".**
 *
 * On the real API, in memory and — with DATABASE_URL — on real PostgreSQL: both waste doors (the governed write-off and the
 * sustainability waste record) refuse a bare event and a reason off the closed list by name, writing nothing; and
 * `GET /v1/waste/analytics` groups what was captured by SKU, by department (the product master's category) and by reason.
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
interface Line { key: string; valueMinor: number; qty: number; events: number; shareBps: number }
interface Analytics { events: number; totalValueMinor: number; bySku: Line[]; byDepartment: Line[]; byReason: Line[]; unclassified: { events: number; reasonsSeen: string[] } }

describe.each(backings)('D-5 — waste is reason-coded and analysed by SKU, department and reason — on $name', ({ harness }) => {
  it('a bare waste event and a reason off the list are refused at both doors, nothing written; the analytics group the rest three ways', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body, idempotencyKey: `${path}-${JSON.stringify(body).length}-${Math.random()}` }), ...(query === undefined ? {} : { query }) });

    // The product master places MILK in "dairy" and BREAD in "bakery"; APPLE is in no master at all.
    for (const [id, cat, name] of [['MILK', 'dairy', 'Milk 1L'], ['BREAD', 'bakery', 'Bread 400g']] as const) {
      expect((await call('POST', `/v1/catalogue/products/${id}/publish`, 'u-owner', { product: { sku: `SKU-${id}`, name, baseUom: 'ea', primaryCategoryId: cat, taxClass: '0401', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: cat, name: cat, parentId: null }] })).status).toBeLessThan(300);
    }
    // The stock being lost, with head office's own cost (SF-05: a loss is valued from it).
    for (const [id, cost] of [['MILK', 5_000], ['BREAD', 2_500], ['APPLE', 1_000]] as const) {
      expect((await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: `rcv-${id}`, productId: id, locationId: 'store-1', kind: 'received', quantityMinor: 100, uom: 'ea', occurredAt: '2026-10-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: cost })).status).toBe(202);
    }
    const writeOff = (id: string, body: Record<string, unknown>) => call('POST', `/v1/inventory/write-off/${id}`, 'u-mgr', { locationId: 'store-1', uom: 'ea', ...body });
    const listed = async () => ((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { count: number }).count;

    // ── "a bare (reasonless) waste event is rejected" — absent, empty, spaces — at the write-off door ─────────────
    for (const [id, reason] of [['bare-1', undefined], ['bare-2', ''], ['bare-3', '   ']] as const) {
      const r = await writeOff(id, { productId: 'MILK', qty: 1, lossType: 'expiry', ...(reason === undefined ? {} : { reasonCode: reason }) });
      expect(r.status, id).toBe(400);
      expect(codeOf(r), id).toBe('waste_reason_required');
    }
    // ── "against a closed reason taxonomy" — free text is refused by name, the list named back ─────────────────
    const free = await writeOff('free-1', { productId: 'MILK', qty: 1, lossType: 'damage', reasonCode: 'leaking' });
    expect(free.status).toBe(400);
    expect(codeOf(free)).toBe('waste_reason_not_in_taxonomy');
    expect((free.body as { error: { whatHappened: string } }).error.whatHappened).toContain(WASTE_REASON_CODES.join(' / '));
    expect(await listed(), 'nothing was written by any refused event').toBe(0);

    // ── the same at the sustainability waste-record door ───────────────────────────────────────────────────────
    const record = (id: string, body: Record<string, unknown>) => call('POST', `/v1/waste/records/${id}`, 'u-mgr', { branchId: 'store-1', departmentId: 'bakery', productId: 'BREAD', at: '2026-10-10T08:00:00.000Z', valueMinor: 2_500, disposal: 'composted', ...body });
    expect(codeOf(await record('rec-bare', {}))).toBe('waste_reason_required');
    expect(codeOf(await record('rec-free', { source: 'stale' }))).toBe('waste_reason_not_in_taxonomy');

    // ── captured against the list ─────────────────────────────────────────────────────────────────────────────
    expect((await writeOff('w1', { productId: 'MILK', qty: 6, lossType: 'expiry', reasonCode: 'expiry' })).status).toBe(201);  // ₹300
    expect((await writeOff('w2', { productId: 'MILK', qty: 2, lossType: 'damage', reasonCode: 'damage' })).status).toBe(201);  // ₹100
    expect((await writeOff('w3', { productId: 'BREAD', qty: 4, lossType: 'wastage', reasonCode: 'expiry' })).status).toBe(201); // ₹100
    expect((await writeOff('w4', { productId: 'APPLE', qty: 3, lossType: 'wastage', reasonCode: 'shrinkage' })).status).toBe(201); // ₹30
    expect((await record('rec-1', { source: 'preparation' })).status).toBe(201);
    expect((await record('rec-2', { productId: 'MILK', departmentId: 'dairy', source: 'expiry', valueMinor: 1_000 })).status).toBe(201);
    expect(await listed()).toBe(4);

    // ── "analytics aggregate by SKU/dept/reason" ─────────────────────────────────────────────────────────────
    const read = await call('GET', '/v1/waste/analytics', 'u-owner', undefined, { from: '2026-10-01', to: '2026-12-31' });
    expect(read.status).toBe(200);
    const body = read.body as { writeOffs: Analytics; wasteRecords: Analytics };
    const w = body.writeOffs;
    expect(w.events).toBe(4);
    expect(w.totalValueMinor).toBe(53_000);
    expect(w.bySku.map((l) => [l.key, l.valueMinor, l.qty])).toEqual([['MILK', 40_000, 8], ['BREAD', 10_000, 4], ['APPLE', 3_000, 3]]);
    expect(w.byDepartment.map((l) => [l.key, l.valueMinor])).toEqual([['dairy', 40_000], ['bakery', 10_000], ['in no department', 3_000]]);
    expect(w.byReason.map((l) => [l.key, l.valueMinor, l.events])).toEqual([['expiry', 40_000, 2], ['damage', 10_000, 1], ['shrinkage', 3_000, 1]]);
    expect(w.unclassified).toEqual({ events: 0, reasonsSeen: [] });
    // The waste records are their own breakdown — never added into the write-offs (one loss is often recorded both ways).
    expect(body.wasteRecords.byReason.map((l) => [l.key, l.valueMinor])).toEqual([['preparation', 2_500], ['expiry', 1_000]]);
    expect(body.wasteRecords.byDepartment.map((l) => l.key)).toEqual(['bakery', 'dairy']);

    // A window with nothing in it, a malformed window, and the read's permission (waste.view).
    expect(((await call('GET', '/v1/waste/analytics', 'u-owner', undefined, { from: '2025-01-01', to: '2025-01-31' })).body as { writeOffs: Analytics }).writeOffs.events).toBe(0);
    expect(codeOf(await call('GET', '/v1/waste/analytics', 'u-owner', undefined, { from: '2026-12-31', to: '2026-10-01' }))).toBe('waste_analytics_needs_a_window');
    expect((await call('GET', '/v1/waste/analytics', 'u-cash', undefined, { from: '2026-10-01', to: '2026-12-31' })).status).toBe(403);
  });
});
