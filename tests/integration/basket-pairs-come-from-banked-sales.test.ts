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
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **D-23 (R4, signed OB-227): bought-together pairs come from the bills head office BANKED.** "From banked sales for a
 * period and department, the system lists product pairs bought together more often than chance, each with its basket
 * count, support, confidence and lift. Pairs seen in fewer than the minimum number of baskets are not shown. Returns are
 * taken out of the baskets they came from. Suggestions (place side by side, bundle, promotion) are drafts; a promotion
 * made from one goes through the existing promotion approval." On the real API, in memory and on real PostgreSQL.
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
const DAY = '2026-09-10';
interface Pair { productA: string; productB: string; basketCount: number; support: number; confidenceAtoB: number; confidenceBtoA: number; lift: number; suggestions: { kind: string; draft: boolean }[]; draftPromotion: { definition: { productIds: string[] } } }
interface Affinity { basketCount: number; pairs: Pair[]; belowMinimum: number; returnsTakenOut: number; changesAnything: boolean; department: string | null }

describe.each(backings)('bought-together pairs come from banked sales — on $name (D-23)', ({ harness }) => {
  it('pairs above chance with their counts and ratios; the minimum and the department narrow; returns are taken out; a promotion is a draft', async () => {
    const h = harness();
    const T = randomUUID();
    if (h.store instanceof SqlEventStore) await h.store.registerTenant(T, 'test/provision');
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    await ok(req('POST', '/v1/catalogue/tax-classes/09024020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    const cats = [{ categoryId: 'grocery', name: 'Grocery', parentId: null }, { categoryId: 'tea', name: 'Tea', parentId: 'grocery' }, { categoryId: 'snacks', name: 'Snacks', parentId: 'grocery' }, { categoryId: 'household', name: 'Household', parentId: null }];
    for (const [id, cat] of [['p-tea', 'tea'], ['p-biscuit', 'snacks'], ['p-milk', 'grocery'], ['p-soap', 'household']] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '09024020', lifecycle: 'draft' }, categories: cats }), `publish ${id}`);
    }
    let n = 0;
    const bill = async (products: readonly string[]): Promise<string> => {
      n += 1;
      await ok(req('POST', '/v1/sales', {
        saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: 'store-01', cashierId: 'u-owner', tradingDay: DAY, committedAt: `${DAY}T06:${String(n).padStart(2, '0')}:00.000Z`,
        totalMinor: products.length * 1_000, currency: 'INR', packVersion: 1,
        lines: products.map((p) => ({ productId: p, quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 })), tenders: [{ kind: 'cash', amountMinor: products.length * 1_000 }],
      }), `sale ${n}`);
      return `S-${n}`;
    };
    for (let i = 0; i < 4; i += 1) await bill(['p-tea', 'p-biscuit']);
    await bill(['p-tea', 'p-milk']);
    for (let i = 0; i < 2; i += 1) await bill(['p-tea', 'p-soap']);
    for (let i = 0; i < 3; i += 1) await bill(['p-milk']);
    const returned = await bill(['p-tea', 'p-biscuit']);
    // A bill on another day, outside the window, is not counted.
    n += 1;
    await ok(req('POST', '/v1/sales', { saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: 'store-01', cashierId: 'u-owner', tradingDay: '2026-08-01', committedAt: '2026-08-01T06:00:00.000Z', totalMinor: 2_000, currency: 'INR', packVersion: 1, lines: ['p-tea', 'p-soap'].map((p) => ({ productId: p, quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 })), tenders: [{ kind: 'cash', amountMinor: 2_000 }] }), 'old sale');
    // The biscuit came back against the last bill — a banked return on the returns ledger.
    await h.store.append(T, 'returns', makeEvent({
      id: 'ret-1', type: 'ReturnRecorded', occurredAt: `${DAY}T09:00:00.000Z`, idempotencyKey: `return-${T}-ret-1`, source: 'test',
      payload: { returnId: 'ret-1', number: 'RT-1', originalSaleId: returned, processedBy: 'u-owner', processedAt: `${DAY}T09:00:00.000Z`, reasonCode: 'changed_mind', refundMinor: 1_000, refundTender: 'cash', refundStatus: 'refunded', lines: [{ productId: 'p-biscuit', quantityMinor: 1, uom: 'ea' }] },
    }));

    const q = (query: Record<string, string>, userId = 'u-owner') => req('GET', '/v1/reporting/basket-affinity', undefined, userId, query);
    expect(codeOf(await q({ from: DAY, to: DAY }))).toBe('not_readable_as_a_basket_query'); // no minimum: none is invented
    expect((await q({ from: DAY, to: DAY, minBaskets: '3' }, 'u-cash')).status).toBe(403);

    const all = (await ok(q({ from: DAY, to: DAY, minBaskets: '3' }), 'all departments')).body as Affinity;
    expect(all.basketCount).toBe(11);
    expect(all.returnsTakenOut).toBe(1);
    expect(all.changesAnything).toBe(false);
    // tea+biscuit: 4 baskets (the returned biscuit no longer counts), of 11; tea in 8, biscuit in 4. lift = 4·11 / (8·4).
    expect(all.pairs.map((p) => [p.productA, p.productB, p.basketCount, p.support, p.confidenceAtoB, p.confidenceBtoA, p.lift])).toEqual([['p-biscuit', 'p-tea', 4, 0.3636, 1, 0.5, 1.375]]);
    expect(all.pairs[0]!.suggestions.map((s) => [s.kind, s.draft])).toEqual([['place_side_by_side', true], ['bundle', true], ['promotion', true]]);
    // tea+soap is above chance too but seen in only 2 baskets: not shown, counted.
    expect(all.belowMinimum).toBe(1);
    expect(((await ok(q({ from: DAY, to: DAY, minBaskets: '2' }), 'min 2')).body as Affinity).pairs.map((p) => `${p.productA}+${p.productB}`)).toEqual(['p-biscuit+p-tea', 'p-soap+p-tea']);

    // The department narrows every basket to its products (a category and its children): no soap pair in Grocery.
    const grocery = (await ok(q({ from: DAY, to: DAY, minBaskets: '2', department: 'grocery' }), 'grocery')).body as Affinity;
    expect(grocery.department).toBe('grocery');
    expect(grocery.pairs.map((p) => `${p.productA}+${p.productB}`)).toEqual(['p-biscuit+p-tea']);
    expect(grocery.belowMinimum).toBe(0);

    // A promotion made from a pair is a DRAFT definition on the existing route; it does not apply until it is launched.
    const def = all.pairs[0]!.draftPromotion.definition;
    await ok(req('POST', '/v1/promotions/aff-1/definition', { ...def, percentBps: 500, startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2099-12-31T00:00:00.000Z' }), 'draft promotion');
    const promo = (await ok(req('GET', '/v1/promotions/aff-1/definition'), 'read')).body as { status: string; productIds: string[] };
    expect([promo.status, promo.productIds]).toEqual(['draft', ['p-biscuit', 'p-tea']]);
    expect(codeOf(await req('POST', '/v1/promotions/aff-1/activate', {}))).toBe('promotion_not_launched');
  }, 120_000);
});
