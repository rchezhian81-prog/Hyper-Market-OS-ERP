import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { seedSubstitutionTruth, SWAP_PRODUCTS } from '../support/substitution-truth';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **D08-FR-02 / D08-FR-05 · WF-16 · WF-17 (round 8) — the signed-in customer keeps favourites and lists on the shop, and
 * raises a complaint or a return request from the app that lands on the service desk.** Through the real API surface, in
 * memory and, with DATABASE_URL, on real PostgreSQL:
 *
 *   • favourites and lists are the customer's OWN (another customer sees none of them); only products the shop sells;
 *     a list is versioned, append-only;
 *   • a complaint opens a case on the desk under the customer's reference, about their own order only (another
 *     customer's order is answered as if it did not exist);
 *   • a return request needs the goods received (collected/delivered), lines on that order and no more than was ordered —
 *     across requests; it moves no money and no stock, and opens a desk case;
 *   • the reply a PERSON sent on the case reaches the customer's "my cases", in the words approved;
 *   • the desk's own staff role cannot use the customer's routes, and a customer cannot read the desk's cases.
 */

const OWNER = 'u-owner'; const DESK = 'u-desk'; const C1 = 'cust-1'; const C2 = 'cust-2';

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('the customer\'s own lists, favourites, complaints and returns — on $name', ({ harness }) => {
  let h: ApiHarness;
  const T = randomUUID();
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const code = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

  beforeAll(async () => {
    h = harness();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, DESK, 'store_manager');
    await h.provisionRole(T, C1, 'customer');
    await h.provisionRole(T, C2, 'customer');
    await h.enableFeature(T, 'customer_app');
    await seedSubstitutionTruth(h, T, SWAP_PRODUCTS);
    expect((await call('POST', '/v1/inventory/movements', OWNER, { movementId: 'mv-milk', productId: 'MILK', locationId: 'L1', kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER })).status).toBeLessThan(300);
  }, 120_000);

  it('favourites and lists are the customer\'s own, of products the shop sells, kept as versions', async () => {
    expect((await call('POST', '/v1/me/favourites/MILK', C1, { favourite: true })).status).toBe(200);
    expect((await call('POST', '/v1/me/favourites/MILK-ALT', C1, { favourite: true })).status).toBe(200);
    expect((await call('POST', '/v1/me/favourites/MILK-ALT', C1, { favourite: false })).status).toBe(200);
    expect(code(await call('POST', '/v1/me/favourites/NOT-SOLD', C1, { favourite: true }))).toBe('unknown_product');
    expect(((await call('GET', '/v1/me/favourites', C1)).body as { favourites: { productId: string }[] }).favourites.map((f) => f.productId)).toEqual(['MILK']);
    expect(((await call('GET', '/v1/me/favourites', C2)).body as { count: number }).count).toBe(0);

    expect((await call('POST', '/v1/me/lists/weekly', C1, { name: 'Weekly', items: [{ productId: 'MILK', quantityMinor: 2 }] })).status).toBe(201);
    const v2 = await call('POST', '/v1/me/lists/weekly', C1, { name: 'Weekly shop', items: [{ productId: 'MILK', quantityMinor: 3 }, { productId: 'MILK-ALT', quantityMinor: 1 }] });
    expect((v2.body as { list: { version: number } }).list.version).toBe(2);
    expect(code(await call('POST', '/v1/me/lists/odd', C1, { name: 'Odd', items: [{ productId: 'NOT-SOLD', quantityMinor: 1 }] }))).toBe('unknown_product');
    expect(code(await call('POST', '/v1/me/lists/zero', C1, { name: 'Zero', items: [{ productId: 'MILK', quantityMinor: 0 }] }))).toBe('not_readable_as_a_list');
    const mine = (await call('GET', '/v1/me/lists', C1)).body as { lists: { listId: string; name: string; version: number; items: unknown[] }[] };
    expect(mine.lists).toEqual([expect.objectContaining({ listId: 'weekly', name: 'Weekly shop', version: 2, items: [{ productId: 'MILK', quantityMinor: 3 }, { productId: 'MILK-ALT', quantityMinor: 1 }] })]);
    expect(((await call('GET', '/v1/me/lists', C2)).body as { count: number }).count).toBe(0);
    // Archived lists leave the app's view; the versions stay on the record.
    expect((await call('POST', '/v1/me/lists/weekly', C1, { name: 'Weekly shop', archived: true })).status).toBe(201);
    expect(((await call('GET', '/v1/me/lists', C1)).body as { count: number }).count).toBe(0);
    // A member of staff is not a customer: the customer's routes are not theirs.
    expect((await call('GET', '/v1/me/lists', DESK)).status).toBe(403);
  });

  it('a complaint and a return request land on the service desk; a reply a person sent reaches the customer', async () => {
    // C1 places a pickup order of 3 milk; it is collected.
    expect((await call('POST', '/v1/storefront/orders/ORD-C1', C1, { lines: [{ productId: 'MILK', quantityMinor: 3 }], locationId: 'L1', fulfilment: 'pickup' })).status).toBe(201);
    // Not received yet: a return is refused, saying why.
    expect(code(await call('POST', '/v1/me/orders/ORD-C1/return-requests/r-early', C1, { lines: [{ productId: 'MILK', quantityMinor: 1 }], reason: 'sour' }))).toBe('order_not_received_yet');
    for (const event of ['confirm', 'pick', 'pack', 'collect']) expect((await call('POST', '/v1/orders/ORD-C1/transition', OWNER, { event }, `t-${event}`)).status, event).toBe(200);

    // Another customer's order is answered as if it did not exist.
    expect((await call('POST', '/v1/me/orders/ORD-C1/return-requests/r-x', C2, { lines: [{ productId: 'MILK', quantityMinor: 1 }], reason: 'x' })).status).toBe(404);
    expect((await call('POST', '/v1/me/complaints/k-x', C2, { summary: 'about their order', orderRef: 'ORD-C1' })).status).toBe(404);

    // The return: 2 of the 3; then asking for 2 more is more than was ordered.
    const ret = await call('POST', '/v1/me/orders/ORD-C1/return-requests/r1', C1, { lines: [{ productId: 'MILK', quantityMinor: 2 }], reason: 'two were sour' }, 'ret-r1');
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    expect((await call('POST', '/v1/me/orders/ORD-C1/return-requests/r1', C1, { lines: [{ productId: 'MILK', quantityMinor: 2 }], reason: 'two were sour' }, 'ret-r1')).status).toBe(201); // the same request again
    expect((await call('POST', '/v1/me/orders/ORD-C1/return-requests/r1', C1, { lines: [{ productId: 'MILK', quantityMinor: 2 }], reason: 'again' })).body).toMatchObject({ alreadyRaised: true });
    expect(code(await call('POST', '/v1/me/orders/ORD-C1/return-requests/r2', C1, { lines: [{ productId: 'MILK', quantityMinor: 2 }], reason: 'more' }))).toBe('more_than_was_ordered');
    expect(code(await call('POST', '/v1/me/orders/ORD-C1/return-requests/r3', C1, { lines: [{ productId: 'MILK-ALT', quantityMinor: 1 }], reason: 'never bought' }))).toBe('more_than_was_ordered');

    // A complaint about the order.
    const comp = await call('POST', '/v1/me/complaints/k1', C1, { summary: 'The milk was sour', orderRef: 'ORD-C1' });
    expect(comp.status).toBe(201);
    expect((comp.body as { caseId: string }).caseId).toBe('app-k1');

    // Both are on the desk's own register, as complaints under the customer's reference — the desk works them.
    const desk = (await call('GET', '/v1/service/cases', DESK)).body as { cases: { caseId: string; kind: string; state: string; assignedTo: string }[] };
    expect(desk.cases.filter((c) => c.caseId.startsWith('app-')).map((c) => [c.caseId, c.kind, c.state, c.assignedTo]).sort()).toEqual([
      ['app-k1', 'complaint', 'open', 'service-desk'], ['app-return-r1', 'complaint', 'open', 'service-desk'],
    ]);
    expect((await call('GET', '/v1/service/cases', C1)).status).toBe(403); // the desk's register is not the customer's

    // Nothing moved: the stock ledger shows no return (the desk receives the goods through the return surface).
    const avail = (await call('GET', '/v1/inventory/availability', OWNER)).body as { rows: { productId: string; onHandMinor: number }[] };
    const before = avail.rows.filter((r) => r.productId === 'MILK').reduce((t, r) => t + r.onHandMinor, 0);

    // A person replies on the complaint (a draft written at the desk, approved, sent by phone).
    expect((await call('POST', '/v1/service/cases/app-k1/drafts/d1', DESK, { text: 'Sorry — we will replace it.', modelRef: 'desk-written', evidenceRefs: ['case:app-k1'] })).status).toBe(201);
    expect((await call('POST', '/v1/service/cases/app-k1/drafts/d1/decision', DESK, { decision: 'approved' })).status).toBe(201);
    expect((await call('POST', '/v1/service/cases/app-k1/drafts/d1/send', DESK, { channel: 'phone' })).status).toBe(201);

    const mine = (await call('GET', '/v1/me/cases', C1)).body as { cases: { caseId: string; state: string; replies: { text: string }[]; returnRequest?: { lines: unknown[] } }[] };
    expect(mine.cases.map((c) => c.caseId).sort()).toEqual(['app-k1', 'app-return-r1']);
    expect(mine.cases.find((c) => c.caseId === 'app-k1')!.replies.map((r) => r.text)).toEqual(['Sorry — we will replace it.']);
    expect(mine.cases.find((c) => c.caseId === 'app-return-r1')!.returnRequest).toEqual({ requestId: 'r1', lines: [{ productId: 'MILK', quantityMinor: 2 }] });
    expect(((await call('GET', '/v1/me/cases', C2)).body as { count: number }).count).toBe(0);
    const after = ((await call('GET', '/v1/inventory/availability', OWNER)).body as { rows: { productId: string; onHandMinor: number }[] }).rows.filter((r) => r.productId === 'MILK').reduce((t, r) => t + r.onHandMinor, 0);
    expect(after).toBe(before);
  });
});
