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
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **D-22 (R4, signed OB-227): personal offers from a member's own purchase history.** "From a consenting adult member's own
 * purchase history, the system drafts personal offers. A person approves each batch before any is issued. A member
 * without both profiling and marketing consent gets none ('no consent'); a member under 18 or with no age confirmed gets
 * none ('child or age unknown'). No member gets more than your cap of 2 offers in 7 days (OB-42). An offer never takes a
 * price below cost or above MRP. No AI issues or commits an offer." On the real API, in memory and on real PostgreSQL,
 * with a cold restart between drafting and approving.
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
  const pg = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const STORE = 'store-01';
const today = (): string => shopDateIn(new Date().toISOString());
const daysAgo = (n: number): string => new Date(Date.parse(`${today()}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
interface Batch { batchId: string; state: string; offers: { customerRef: string; productId: string; offerPriceMinor: number; discountMinor: number }[]; excluded: { customerRef: string; reason: string; words: string }[]; issued?: { customerRef: string; code: string }[]; notIssued?: { customerRef: string; reason: string }[] }

describe.each(backings)('personal offers need consent, an adult and a person — on $name (D-22)', ({ harness, restart }) => {
  it('drafts from own history; consent, age, cap and the cost/MRP floors decide; only a person\'s approval issues', async () => {
    let h = harness();
    const T = randomUUID();
    if (h.store instanceof SqlEventStore) await h.store.registerTenant(T, 'test/provision');
    await h.seedOwner(T, 'u-owner');
    await h.enableFeature(T, 'loyalty');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // Products: shelf price ₹100, MRP ₹120; tea costs ₹60, oil costs ₹98 (a 10% offer would sell it below cost); the
    // biscuit has no MRP on file (its offer cannot be shown to be at or under MRP).
    await ok(req('POST', '/v1/catalogue/tax-classes/09024020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    const MRP = [{ value: { minor: 12_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }];
    for (const [id, cost, mrp] of [['p-tea', 6_000, true], ['p-oil', 9_800, true], ['p-biscuit', 5_000, false]] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '09024020', lifecycle: 'draft', ...(mrp ? { mrpHistory: MRP } : {}) }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), `publish ${id}`);
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: 10_000, mrpMinor: 12_000, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today() }), `price ${id}`);
      await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${id}`, productId: id, locationId: STORE, kind: 'received', quantityMinor: 100, uom: 'EA', occurredAt: `${daysAgo(20)}T05:00:00.000Z`, enteredBy: 'u-owner', unitCostMinor: cost }), `receive ${id}`);
    }
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: today() }), 'pack');

    // Banked bills naming members.
    let n = 0;
    const sell = async (member: string, productId: string, day: string) => {
      n += 1;
      await ok(req('POST', '/v1/sales', {
        saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: STORE, cashierId: 'u-owner', tradingDay: day, committedAt: `${day}T06:00:00.000Z`,
        totalMinor: 10_000, currency: 'INR', packVersion: 1, customerRef: member,
        lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_000, lineTotalMinor: 10_000 }], tenders: [{ kind: 'cash', amountMinor: 10_000 }],
      }), `sale ${n}`);
    };
    for (const d of [5, 4, 3]) await sell('M-adult', 'p-tea', daysAgo(d));
    await sell('M-adult', 'p-oil', daysAgo(2));
    for (const m of ['M-noconsent', 'M-child', 'M-unknown', 'M-late']) await sell(m, 'p-tea', daysAgo(3));
    await sell('M-cost', 'p-oil', daysAgo(3));
    await sell('M-mrp', 'p-biscuit', daysAgo(3));
    const consent = (m: string, purpose: string, given: boolean) => ok(req('POST', `/v1/customers/${m}/consent`, { purpose, channel: 'sms', given, evidence: 'synthetic desk consent' }), `consent ${m} ${purpose}`);
    for (const m of ['M-adult', 'M-child', 'M-unknown', 'M-cost', 'M-mrp', 'M-late']) { await consent(m, 'profiling', true); await consent(m, 'marketing', true); }
    await consent('M-noconsent', 'profiling', true); // profiling only — not marketing
    for (const [m, adult] of [['M-adult', true], ['M-child', false], ['M-cost', true], ['M-mrp', true], ['M-noconsent', true], ['M-late', true]] as const) {
      await ok(req('POST', `/v1/customer/age-confirmations/${m}`, { adult }, 'u-mgr'), `age ${m}`);
    }
    expect(codeOf(await req('POST', '/v1/customer/age-confirmations/M-x', { adult: true, dateOfBirth: '2000-01-01' }))).toBe('date_of_birth_not_kept');

    // The manager drafts; the discount, look-back and validity are his. A draft issues nothing.
    expect(codeOf(await req('POST', '/v1/loyalty/offer-batches/B1', { discountBps: 1_000 }, 'u-mgr'))).toBe('not_readable_as_an_offer_batch');
    expect((await req('POST', '/v1/loyalty/offer-batches/B1', { discountBps: 1_000, lookbackDays: 30, validDays: 7 }, 'u-cash')).status).toBe(403);
    const drafted = ((await ok(req('POST', '/v1/loyalty/offer-batches/B1', { discountBps: 1_000, lookbackDays: 30, validDays: 7 }, 'u-mgr'), 'draft B1')).body as { batch: Batch; issuedAnything: boolean });
    expect(drafted.issuedAnything).toBe(false);
    expect(drafted.batch.offers.map((o) => [o.customerRef, o.productId, o.offerPriceMinor, o.discountMinor])).toEqual([['M-adult', 'p-tea', 9_000, 1_000], ['M-late', 'p-tea', 9_000, 1_000]]);
    expect(Object.fromEntries(drafted.batch.excluded.map((e) => [e.customerRef, e.words]))).toEqual({
      'M-child': 'child or age unknown', 'M-unknown': 'child or age unknown', 'M-noconsent': 'no consent', 'M-cost': 'below cost', 'M-mrp': 'MRP not known',
    });
    expect((await req('GET', '/v1/loyalty/coupons/nbo-B1-M-adult')).status).toBe(404); // nothing issued by drafting

    // Cold restart between draft and approval; the manager cannot approve; consent withdrawn since is caught at issue.
    h = restart(h);
    expect((await req('POST', '/v1/loyalty/offer-batches/B1/approve', {}, 'u-mgr')).status).toBe(403);
    await consent('M-late', 'marketing', false);
    const approved = (await ok(req('POST', '/v1/loyalty/offer-batches/B1/approve', {}), 'approve B1')).body as { batch: Batch };
    expect(approved.batch.state).toBe('approved');
    expect(approved.batch.issued?.map((i) => i.customerRef)).toEqual(['M-adult']);
    expect(approved.batch.notIssued).toEqual([{ customerRef: 'M-late', reason: 'no_consent', words: 'no consent' }]);
    const coupon = (await ok(req('GET', '/v1/loyalty/coupons/nbo-B1-M-adult'), 'coupon')).body as { coupon: { issuedTo: string; personalised: boolean; valueMinor: number; maxRedemptions: number } };
    expect([coupon.coupon.issuedTo, coupon.coupon.personalised, coupon.coupon.valueMinor, coupon.coupon.maxRedemptions]).toEqual(['M-adult', true, 1_000, 1]);
    // Approving again issues nothing more.
    expect(((await ok(req('POST', '/v1/loyalty/offer-batches/B1/approve', {}), 'again')).body as { alreadyApproved?: boolean }).alreadyApproved).toBe(true);

    // The cap: a second offer in 7 days is allowed, a third is not — at drafting and at issue.
    await ok(req('POST', '/v1/loyalty/offer-batches/B2', { discountBps: 500, lookbackDays: 30, validDays: 7 }, 'u-mgr'), 'draft B2');
    expect(((await ok(req('POST', '/v1/loyalty/offer-batches/B2/approve', {}), 'approve B2')).body as { batch: Batch }).batch.issued?.map((i) => i.customerRef)).toEqual(['M-adult']);
    const b3 = ((await ok(req('POST', '/v1/loyalty/offer-batches/B3', { discountBps: 500, lookbackDays: 30, validDays: 7 }, 'u-mgr'), 'draft B3')).body as { batch: Batch }).batch;
    expect(b3.offers).toEqual([]);
    expect(b3.excluded.find((e) => e.customerRef === 'M-adult')?.words).toBe('cap reached (2 offers in 7 days)');

    // A rejected batch issues nothing and cannot be approved afterwards.
    await ok(req('POST', '/v1/loyalty/offer-batches/B4', { discountBps: 500, lookbackDays: 30, validDays: 7 }, 'u-mgr'), 'draft B4');
    expect(codeOf(await req('POST', '/v1/loyalty/offer-batches/B4/reject', {}))).toBe('rejection_needs_a_reason');
    await ok(req('POST', '/v1/loyalty/offer-batches/B4/reject', { reason: 'not this week' }), 'reject B4');
    expect(codeOf(await req('POST', '/v1/loyalty/offer-batches/B4/approve', {}))).toBe('offer_batch_rejected');
    const list = (await ok(req('GET', '/v1/loyalty/offer-batches', undefined, 'u-cash'), 'list')).body as { batches: { batchId: string; state: string }[] };
    expect(list.batches.map((b) => [b.batchId, b.state]).sort()).toEqual([['B1', 'approved'], ['B2', 'approved'], ['B3', 'drafted'], ['B4', 'rejected']]);
  }, 180_000);
});
