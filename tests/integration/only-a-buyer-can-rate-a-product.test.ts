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
import { testModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { seedOnlineShop, deliveredOrder, callsFor, codeOf, saidOf, CASHIER, CUSTOMER, OTHER_CUSTOMER } from '../support/online-shop';

/**
 * **R4 · M20-FR-04 — product ratings, stars only, buyers only (OB-74 · OB-218) — on the real API, in memory and on REAL
 * PostgreSQL, across a cold restart.**
 *
 * A signed-in customer who bought a product rates it 1 to 5 stars, once; a later rating replaces their own, with the
 * history kept. One who never bought it is refused ("rate only what you bought"). There is no place to write a review.
 * The product shows the average and the count, never a name.
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

const provider = testModePaymentProvider();
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness({ paymentVerifier: provider }), restart: (h) => apiHarness({ store: h.store, paymentVerifier: provider }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), paymentVerifier: provider }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

describe.each(backings)('M20-FR-04 — only a buyer can rate a product, on $name', ({ harness, restart }) => {
  it('a buyer rates once and may change it; a non-buyer is refused; words are refused; the summary names nobody', async () => {
    let h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);

    // Not delivered yet: the customer has not bought it.
    provider.capture('tok-ORD-R1', 270_00);
    await ok(req('POST', '/v1/storefront/orders/ORD-R0', { lines: [{ productId: 'BROOM', quantityMinor: 1 }], locationId: 'store-01' }, OTHER_CUSTOMER), 'undelivered order');
    const early = await req('POST', '/v1/me/ratings/BROOM', { stars: 4 }, OTHER_CUSTOMER);
    expect([early.status, codeOf(early)]).toEqual([403, 'rate_only_what_you_bought']);
    expect(saidOf(early)).toMatch(/^rate only what you bought/);

    await deliveredOrder(c, provider, 'ORD-R1');
    // Stars only — a review, a title, or a half star is refused, not trimmed.
    expect(codeOf(await req('POST', '/v1/me/ratings/MILK', { stars: 5, review: 'lovely' }, CUSTOMER))).toBe('stars_only');
    expect(codeOf(await req('POST', '/v1/me/ratings/MILK', { stars: 4.5 }, CUSTOMER))).toBe('not_whole_stars');
    expect(codeOf(await req('POST', '/v1/me/ratings/MILK', { stars: 6 }, CUSTOMER))).toBe('not_whole_stars');
    // Never bought SAREE.
    expect(codeOf(await req('POST', '/v1/me/ratings/SAREE', { stars: 5 }, CUSTOMER))).toBe('rate_only_what_you_bought');
    // A cashier is not a customer.
    expect((await req('POST', '/v1/me/ratings/MILK', { stars: 5 }, CASHIER)).status).toBe(403);

    const first = await ok(req('POST', '/v1/me/ratings/MILK', { stars: 2 }, CUSTOMER), 'rate');
    expect(first.status).toBe(201);
    h = restart(h);
    // A later rating replaces the customer's own — once in the average, the earlier one kept in the history.
    const second = await ok(req('POST', '/v1/me/ratings/MILK', { stars: 4 }, CUSTOMER), 're-rate');
    expect((second.body as { replacedEarlier: boolean; summary: unknown }).replacedEarlier).toBe(true);
    await ok(req('POST', '/v1/me/ratings/BROOM', { stars: 5 }, CUSTOMER), 'rate broom');
    const history = (await h.store.readStream(T, 'orders\u001fonline-store\u001fratings', { type: 'ProductRated' })).map((e) => (e.event.payload as { stars: number; productId: string }));
    expect(history.filter((r) => r.productId === 'MILK').map((r) => r.stars)).toEqual([2, 4]);

    const summary = (await ok(req('GET', '/v1/storefront/ratings', undefined, OTHER_CUSTOMER), 'summary')).body as { ratings: unknown[] };
    expect(summary.ratings).toEqual([{ productId: 'BROOM', count: 1, average: 5 }, { productId: 'MILK', count: 1, average: 4 }]);
    expect(JSON.stringify(summary)).not.toContain(CUSTOMER);
    const listing = (await ok(req('GET', '/v1/storefront/listing', undefined, OTHER_CUSTOMER), 'listing')).body as { products: { productId: string; rating?: unknown }[] };
    expect(listing.products.find((p) => p.productId === 'MILK')!.rating).toEqual({ productId: 'MILK', count: 1, average: 4 });
    expect(listing.products.find((p) => p.productId === 'SAREE')!.rating).toEqual({ productId: 'SAREE', count: 0 });
    const mine = (await ok(req('GET', '/v1/me/ratings', undefined, CUSTOMER), 'mine')).body as { ratings: { productId: string; stars: number }[] };
    expect(mine.ratings.map((r) => [r.productId, r.stars])).toEqual([['BROOM', 5], ['MILK', 4]]);
  }, 120_000);
});
