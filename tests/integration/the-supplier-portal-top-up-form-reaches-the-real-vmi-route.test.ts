import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller } from '../support/p3-purchase';
import type { ApiHarness } from '../support/api-harness';
import { fetchSupplierVmi, postTopUpProposal } from '../../apps/supplier-app/src/browser-entry';

/**
 * **OB-389 — the supplier portal's "Top-up proposal" form, through the portal bundle's own read and write, against the
 * REAL vendor-managed-inventory routes (FG-4), in memory and on real PostgreSQL, with a cold restart.**
 *
 * The bundle's `fetchSupplierVmi` reads `GET /v1/supplier-portal/me/vmi` and its `postTopUpProposal` sends the one
 * proposal `POST /v1/supplier-portal/me/vmi/proposals/:id` — here `fetch` is pointed at the API harness as the signed-in
 * supplier, so the exact body the browser sends is judged by head office. Past the room is refused on the page and
 * nothing is sent; inside it waits for a buyer; the supplier reads it waiting after a restart.
 */

const backings = useRestartableBackings();
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Point the browser's fetch at the harness as `userId`, recording every request. */
function asSupplier(h: () => ApiHarness, T: string, userId: string, seen: { method: string; path: string; body: unknown }[]): void {
  globalThis.fetch = (async (input: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = (init?.method ?? 'GET') as 'GET' | 'POST';
    const body = init?.body === undefined ? undefined : JSON.parse(init.body) as unknown;
    const path = decodeURIComponent(input);
    seen.push({ method, path, body });
    const key = init?.headers?.['idempotency-key'];
    const r = await h().request({ method, path, userId, tenantId: T, ...(key === undefined ? {} : { idempotencyKey: key }), ...(body === undefined ? {} : { body }) });
    return { status: r.status, json: async () => r.body } as unknown as Response;
  }) as typeof fetch;
}

describe.each(backings)('OB-389: the top-up form reaches the real VMI route — on $name', ({ harness }) => {
  it('reads its own items, refuses past the room before sending, sends one proposal that waits for a buyer, kept across a restart', async () => {
    let h = harness();
    const T = randomUUID();
    await p3Shop(h, T, 'sup-1');
    const call = caller(h, T);
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await h.provisionRole(T, 'u-sup1', 'supplier');
    await ok(call('POST', '/v1/catalogue/tax-classes/10063000/rates/2017-07-01', P3.OWNER, { rateBps: 500 }), 'tax');
    await ok(call('POST', '/v1/catalogue/products/p-rice/publish', P3.OWNER, { product: { sku: 'p-rice', name: 'p-rice', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063000', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 'publish');
    await ok(call('POST', '/v1/supplier-portal/partners/sup-1', P3.BUYER, { grants: ['view_orders'], documents: [], requiredDocuments: [], logins: ['u-sup1'] }), 'portal');
    await ok(call('POST', '/v1/inventory/movements', P3.OWNER, { movementId: 'open-rice', productId: 'p-rice', locationId: P3.BACK, kind: 'received', quantityMinor: 15, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: P3.OWNER, unitCostMinor: 4_000 }), 'stock');

    const seen: { method: string; path: string; body: unknown }[] = [];
    asSupplier(() => h, T, 'u-sup1', seen);

    // Not set yet: the server's words come through, never an empty list read as nothing to do.
    const before = await fetchSupplierVmi(true);
    expect(before?.items).toEqual([]);
    expect(before?.notSet).toMatch(/^Not set/);

    await ok(call('POST', `/v1/purchase/vmi/limits/sup-1/${P3.STORE}/p-rice`, P3.BUYER, { minQty: 20, maxQty: 50, uom: 'ea' }), 'limit');
    const feed = await fetchSupplierVmi(true);
    expect(feed?.items).toEqual([expect.objectContaining({ storeId: P3.STORE, productId: 'p-rice', onHand: 15, onOrder: 0, room: 35, belowMinimum: true })]);

    // Past the room: refused on the page — nothing leaves.
    const writesBefore = seen.filter((s) => s.method === 'POST').length;
    expect(await postTopUpProposal({ storeId: P3.STORE, quantities: { 'p-rice': '36' }, note: '' }, feed)).toEqual({ result: 'invalid', why: 'aboveRoom', productId: 'p-rice' });
    expect(seen.filter((s) => s.method === 'POST').length).toBe(writesBefore);

    // Inside the room: one proposal, the exact body head office judged (no supplier named — the login is the supplier).
    const sent = await postTopUpProposal({ storeId: P3.STORE, quantities: { 'p-rice': '30' }, note: ' weekly top-up ' }, feed);
    expect(sent.result, JSON.stringify(sent)).toBe('sent');
    const post = seen.filter((s) => s.method === 'POST');
    expect(post.length).toBe(1);
    expect(post[0]?.path).toMatch(/^\/v1\/supplier-portal\/me\/vmi\/proposals\/vmi-/);
    expect(post[0]?.body).toEqual({ storeId: P3.STORE, lines: [{ productId: 'p-rice', quantity: 30 }], note: 'weekly top-up' });

    // A proposal the server refuses (stock arrived since the page read it: room 50 − 45 = 5) is said in head office's words.
    await ok(call('POST', '/v1/inventory/movements', P3.OWNER, { movementId: 'more-rice', productId: 'p-rice', locationId: P3.BACK, kind: 'received', quantityMinor: 30, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: P3.OWNER, unitCostMinor: 4_000 }), 'more stock');
    const stale = await postTopUpProposal({ storeId: P3.STORE, quantities: { 'p-rice': '10' }, note: '' }, feed);
    expect(stale).toMatchObject({ result: 'refused', whatHappened: expect.stringMatching(/at most 5 may be proposed/) });

    h = harness(h); // ── COLD RESTART ──
    const after = await fetchSupplierVmi(true);
    expect(after?.proposals.map((p) => [p.storeId, p.status, p.lines])).toEqual([[P3.STORE, 'awaiting_buyer', [{ productId: 'p-rice', quantity: 30 }]]]);
    // Nothing was ordered: the buyer still decides.
    const queue = (await ok(caller(h, T)('GET', '/v1/purchase/vmi-proposals', P3.BUYER), 'queue')).body as { awaiting: number };
    expect(queue.awaiting).toBe(1);
  }, 180_000);
});
