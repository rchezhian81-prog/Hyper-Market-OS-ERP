import { describe, it, expect } from 'vitest';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { storeRules } from '../support/store-rules';
import { approvedRequestId } from '../support/approval-request';
import { mrpOnRecord } from '../support/mrp-on-record';

/**
 * **OB-806 A (owner, 16 Nov 2026, in writing: "a manager's price change is sent to the tills automatically once head office
 * accepts it") · daily-work defect D-021 · P-01 · P-08.**
 *
 * Before: "Price saved ₹32" while the tills kept charging ₹30 until the owner pressed "Send to the tills", and the shelf
 * label was already "due now". Now an ACCEPTED price (MRP ceiling, margin floor and any second person's approval passed)
 * is sent at once through the very same signed, versioned pack publish; a refused one, or one still waiting for a second
 * person, never is; one that cannot go yet (a later start day) is said and listed for the owner. Runs on the in-memory event
 * store and, when DATABASE_URL is set, on real PostgreSQL.
 */

type Res = { status: number; body: unknown };
type Pack = { snapshot: { version: number; products: { productId: string; unitPriceMinor: number }[] }; publishedBy: string };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(useBackings())('OB-806 A — an accepted price reaches the tills by itself — on $name', ({ harness }) => {
  async function shop(floorBps = 0): Promise<{ h: ApiHarness; T: string; req: (method: 'GET' | 'POST', path: string, who: string, body?: unknown, query?: Record<string, string>) => Promise<Res>; pack: () => Promise<Pack | undefined> }> {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionOwner(T, 'u-owner2');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await aBranch(h, T, 'u-owner');
    await storeRules(h, T, 'u-owner', 'store-1', floorBps);
    await mrpOnRecord(h, T, 'u-owner', 'p-biscuit', 3_500);
    await mrpOnRecord(h, T, 'u-owner', 'p-salt', 2_500);
    const req = (method: 'GET' | 'POST', path: string, who: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId: who, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const pack = async () => { const r = await req('GET', '/v1/catalogue/pack', 'u-owner'); return r.status === 200 ? r.body as Pack : undefined; };
    return { h, T, req, pack };
  }
  const change = (productId: string, priceMinor: number, mrpMinor: number) => ({ productId, priceMinor, mrpMinor, costMinor: 1_000, currency: 'INR', marginFloorBps: 0 });
  const priceOf = (p: Pack | undefined, id: string) => p?.snapshot.products.find((x) => x.productId === id)?.unitPriceMinor;

  it('the manager\'s accepted price is in a new signed pack for the store at once — nobody presses "Send to the tills"', async () => {
    const { req, pack, T, h } = await shop();
    expect(await pack()).toBeUndefined(); // no pack yet
    const first = await req('POST', '/v1/prices/changes', 'u-mgr', change('p-biscuit', 3_000, 3_500));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ tills: [{ storeId: 'store-1', sent: true, version: 1, withinMinutes: 5 }] });
    const v1 = await pack();
    expect(v1?.snapshot.version).toBe(1);
    expect(priceOf(v1, 'p-biscuit')).toBe(3_000);
    expect(v1?.publishedBy).toBe('u-mgr'); // the person whose accepted price sent it

    const second = await req('POST', '/v1/prices/changes', 'u-mgr', change('p-biscuit', 3_200, 3_500));
    expect(second.body).toMatchObject({ tills: [{ storeId: 'store-1', sent: true, version: 2 }] });
    expect(priceOf(await pack(), 'p-biscuit')).toBe(3_200);
    // The trail says who sent which pack, after which price (§28).
    const trail = ((await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'store', objectId: 'store-1' } })).body as { matches: { action: string; actorId: string; after: Record<string, string> }[] }).matches;
    expect(trail.filter((m) => m.action === 'catalogue.pack.sent_after_accepted_price').map((m) => [m.actorId, m.after['priceMinor'], m.after['packVersion']])).toEqual([['u-mgr', '3000', '1'], ['u-mgr', '3200', '2']]);
  });

  it('a REFUSED price (above the MRP) is never sent — the tills keep the pack they have', async () => {
    const { req, pack } = await shop();
    await req('POST', '/v1/prices/changes', 'u-mgr', change('p-biscuit', 3_000, 3_500));
    const refused = await req('POST', '/v1/prices/changes', 'u-mgr', change('p-biscuit', 3_800, 3_500));
    expect(codeOf(refused)).toBe('price_above_mrp');
    const now = await pack();
    expect(now?.snapshot.version).toBe(1);
    expect(priceOf(now, 'p-biscuit')).toBe(3_000);
  });

  it('a price WAITING for a second person is not sent; once that person approves it, it goes', async () => {
    const { h, T, req, pack } = await shop(2_000); // the owner's margin floor: 20%
    const thin = change('p-salt', 1_100, 2_500); // 9% margin — under the floor
    const waiting = await req('POST', '/v1/prices/changes', 'u-mgr', thin);
    expect(waiting.status).toBe(422);
    expect(await pack()).toBeUndefined(); // nothing went to the tills
    const approvalId = await approvedRequestId(h, T, 'u-mgr', 'u-owner', { kind: 'price_change', subjectRef: 'p-salt', details: thin, valueMinor: 1_100 });
    const approved = await req('POST', '/v1/prices/changes', 'u-mgr', { ...thin, approvalId });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body).toMatchObject({ tills: [{ storeId: 'store-1', sent: true }] });
    expect(priceOf(await pack(), 'p-salt')).toBe(1_100);
  });

  it('a store price starting on a LATER day is saved but cannot go yet — said, and listed for the owner until a pack goes', async () => {
    const { req } = await shop();
    const later = await req('POST', '/v1/prices/list/p-salt/entries/e-later', 'u-owner', { scope: 'store', scopeRef: 'store-1', priceMinor: 2_200, mrpMinor: 2_500, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2099-01-01' });
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    expect(later.body).toMatchObject({ tills: [{ storeId: 'store-1', sent: false, reason: 'starts_later' }] });
    const listed = await req('GET', '/v1/catalogue/pack/not-sent', 'u-owner', undefined, { storeId: 'store-1' });
    expect(listed.body).toMatchObject({ count: 1, notSent: [{ productId: 'p-salt', priceMinor: 2_200, reason: 'starts_later', by: 'u-owner' }] });
    // A pack that goes for the store (here: the next accepted price) settles the list.
    const sent = await req('POST', '/v1/prices/changes', 'u-mgr', change('p-biscuit', 3_000, 3_500));
    expect(sent.body).toMatchObject({ tills: [{ sent: true }] });
    expect((await req('GET', '/v1/catalogue/pack/not-sent', 'u-owner', undefined, { storeId: 'store-1' })).body).toMatchObject({ count: 0 });
  });

  it('a store price for today saved on Price lists is sent too — the same rule as Change price', async () => {
    const { req, pack } = await shop();
    const today = await req('POST', '/v1/prices/list/p-salt/entries/e-today', 'u-owner', { scope: 'store', scopeRef: 'store-1', priceMinor: 2_000, mrpMinor: 2_500, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: shopDateIn(new Date().toISOString()) }); // the shop's today, not the UTC date
    expect(today.status, JSON.stringify(today.body)).toBe(201);
    expect((today.body as { tills: { sent: boolean }[] }).tills[0]!.sent).toBe(true);
    expect(priceOf(await pack(), 'p-salt')).toBe(2_000);
  });
});
