import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **D-18 (R4, OB-216) — a competitor's price drafts a price change; a person commits it through the existing price route**,
 * on the real API, in memory and on REAL PostgreSQL, with a cold restart:
 *
 *   • tea: a competitor 6% below, seen 2 days ago → a draft to its price, within MRP and above the 20% margin floor;
 *   • oil: a competitor 6% below, but matching it falls under the margin floor → "draft refused: below margin floor";
 *   • salt: its only competitor sighting is 20 days old → "sighting too old"; milk: no buying cost known → said;
 *   • reading the drafts changes no price; the owner changes the gap (a new version, kept) and the answer follows; a store
 *     manager may not change the rule (403); a cashier may not read drafts (403); no store → 400;
 *   • a person commits the tea draft through POST /v1/prices/changes — the shelf price moves only then, and the draft is gone;
 *     the refused oil price is refused again by that route unless a second person approves it.
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

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

const STORE = 'store-1';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - 60_000).toISOString();
const RULES = {
  approvalLimitMinor: 500_000, marginFloorBps: 2_000, nearExpiryDays: 30,
  reporting: { laggingAfterMinutes: 5, staleAfterMinutes: 60 },
  service: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 },
  journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' }, dormantAfterDays: 60, aiStaleAfterMinutes: 60,
  merchandising: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' },
  writeOffMaterialThresholdMinor: 50_000,
  checklist: [{ itemId: 'close-1', description: 'Count every till blind', blocking: true }],
};
interface Draft { productId: string; fromPriceMinor: number; draftPriceMinor: number; mrpMinor: number; costMinor: number; competitor: string; advisoryOnly: boolean; commitVia: string }
interface NotDrafted { productId: string; reason: string; words: string }
interface Drafts { drafts: Draft[]; notDrafted: NotDrafted[]; pricesChanged: boolean; advisoryOnly: boolean; rule: { gapBps: number; maxAgeDays: number; source: string; version: number | null } }

describe.each(backings)('a competitor gap drafts a price a person approves — on $name (D-18)', ({ harness, restart }) => {
  it('drafts within MRP and the floor, refuses below the floor, ignores an old sighting, changes nothing until a person commits', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await deliveryPlaces(h, T, STORE);
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const today = shopDateIn(new Date().toISOString());
    await ok(req('POST', '/v1/catalogue/tax-classes/09024020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', `/v1/stores/${STORE}/rules`, RULES), 'store rules (20% floor)');
    const product = async (id: string, shelf: number, mrp: number, cost: number | null) => {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '09024020', lifecycle: 'draft', mrpHistory: [{ value: { minor: mrp, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), `publish ${id}`);
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: shelf, mrpMinor: mrp, costMinor: cost ?? 0, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), `price ${id}`);
      if (cost !== null) await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${id}`, productId: id, locationId: STORE, kind: 'received', quantityMinor: 10, uom: 'EA', occurredAt: daysAgo(30), enteredBy: 'u-owner', unitCostMinor: cost }), `receive ${id}`);
    };
    await product('p-tea', 10_000, 10_500, 7_000);
    await product('p-oil', 20_000, 21_000, 17_000);
    await product('p-salt', 2_000, 2_200, 1_200);
    await product('p-milk', 3_000, 3_200, null);
    const seen = (id: string, productId: string, competitor: string, priceMinor: number, ago: number) =>
      ok(req('POST', `/v1/prices/competitor/${id}`, { productId, storeId: STORE, competitor, priceMinor, observedAt: daysAgo(ago), source: 'shelf_visit' }, 'u-mgr'), `sighting ${id}`);
    await seen('o-tea', 'p-tea', 'Shop A', 9_400, 2);
    await seen('o-oil', 'p-oil', 'Shop B', 18_800, 1);
    await seen('o-salt', 'p-salt', 'Shop C', 1_700, 20);
    await seen('o-milk', 'p-milk', 'Shop A', 2_700, 1);
    const drafts = async (userId = 'u-mgr'): Promise<Drafts> => (await ok(req('GET', '/v1/prices/competitor-drafts', undefined, userId, { storeId: STORE }), 'drafts')).body as Drafts;
    const shelf = async (id: string): Promise<number> => ((await ok(req('GET', `/v1/prices/list/${id}/resolve`, undefined, 'u-owner', { storeId: STORE, at: new Date().toISOString() }), `resolve ${id}`)).body as { priceMinor: number }).priceMinor;

    const first = await drafts();
    expect(first.rule).toMatchObject({ gapBps: 500, maxAgeDays: 14, source: 'owner_decision_OB-216', version: null });
    expect(first).toMatchObject({ advisoryOnly: true, pricesChanged: false });
    expect(first.drafts).toHaveLength(1);
    expect(first.drafts[0]).toMatchObject({ productId: 'p-tea', fromPriceMinor: 10_000, draftPriceMinor: 9_400, mrpMinor: 10_500, costMinor: 7_000, competitor: 'Shop A', advisoryOnly: true });
    expect(first.drafts[0]!.commitVia).toMatch(/POST \/v1\/prices\/changes/);
    const why = Object.fromEntries(first.notDrafted.map((n) => [n.productId, n.words]));
    expect(why).toEqual({ 'p-oil': 'draft refused: below margin floor', 'p-salt': 'sighting too old', 'p-milk': 'cost not known' });
    expect(await shelf('p-tea')).toBe(10_000); // reading the drafts changed no price

    // The owner changes the gap to 10%: a new version, the answer follows; a store manager may not change it.
    expect((await req('POST', '/v1/prices/competitor-rule', { gapBps: 1_000, maxAgeDays: 14, reason: 'only chase big gaps' }, 'u-mgr')).status).toBe(403);
    expect(codeOf(await req('POST', '/v1/prices/competitor-rule', { gapBps: 0, maxAgeDays: 14, reason: 'x' }))).toBe('not_readable_as_a_competitor_rule');
    await ok(req('POST', '/v1/prices/competitor-rule', { gapBps: 1_000, maxAgeDays: 14, reason: 'only chase big gaps' }), 'rule v1');
    expect((await drafts()).drafts).toEqual([]);

    // ── A COLD RESTART: the rule and its history are rebuilt from the store ─────────────────────────────────────────
    h = restart(h);
    const rule = (await ok(req('GET', '/v1/prices/competitor-rule', undefined, 'u-mgr'), 'rule')).body as { rule: { gapBps: number }; source: string; version: number; history: unknown[] };
    expect(rule).toMatchObject({ rule: { gapBps: 1_000 }, source: 'owner_setting', version: 1 });
    await ok(req('POST', '/v1/prices/competitor-rule', { gapBps: 500, maxAgeDays: 14, reason: 'back to the agreed 5%' }), 'rule v2');
    expect(((await ok(req('GET', '/v1/prices/competitor-rule', undefined, 'u-mgr'), 'rule')).body as { history: unknown[] }).history).toHaveLength(2);
    const again = await drafts();
    expect(again.drafts.map((d) => d.productId)).toEqual(['p-tea']);

    // Permissions and error paths.
    expect((await req('GET', '/v1/prices/competitor-drafts', undefined, 'u-cash', { storeId: STORE })).status).toBe(403);
    expect(codeOf(await req('GET', '/v1/prices/competitor-drafts', undefined, 'u-mgr'))).toBe('store_required');

    // A PERSON commits the draft through the existing price route; only then does the shelf price move.
    const d = again.drafts[0]!;
    await ok(req('POST', '/v1/prices/changes', { productId: d.productId, priceMinor: d.draftPriceMinor, mrpMinor: d.mrpMinor, costMinor: d.costMinor, currency: 'INR', storeId: STORE }, 'u-mgr'), 'commit tea');
    expect(await shelf('p-tea')).toBe(9_400);
    expect((await drafts()).drafts).toEqual([]);
    // The refused oil price is refused again by the price route itself without a second person's approval.
    const oil = await req('POST', '/v1/prices/changes', { productId: 'p-oil', priceMinor: 18_800, mrpMinor: 21_000, costMinor: 17_000, currency: 'INR', storeId: STORE }, 'u-mgr');
    expect(oil.status).toBe(422);
    expect(codeOf(oil)).toBe('price_below_floor');
    expect(await shelf('p-oil')).toBe(20_000);
  }, 120_000);
});
