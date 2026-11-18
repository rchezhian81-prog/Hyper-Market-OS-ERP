import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { storeRules } from '../support/store-rules';
import { mrpOnRecord } from '../support/mrp-on-record';

/**
 * **Daily-work defect D-021 (owner, 18 Nov 2026, under OB-801) · OB-806 A · P-08.**
 *
 * A price accepted for a LATER day goes to the tills by itself on its start day — nobody presses "Send to the tills". When
 * the store computer asks for its pack, head office first sends every price whose day has now come, through the same signed
 * pack publish. Never early, never twice, and the not-sent list stays honest. The catalogue's clock is moved past the start
 * day. Runs on the in-memory event store and, when DATABASE_URL is set, on real PostgreSQL.
 */

type Res = { status: number; body: unknown };
type Pack = { snapshot: { version: number; products: { productId: string; unitPriceMinor: number }[] }; publishedBy: string };
const DAY = 86_400_000;

// The catalogue's clock: it starts now and each test pushes it on.
let offsetMs = 0;
const clock = (): string => new Date(Date.now() + offsetMs).toISOString();

describe.each(useBackings({ catalogueNow: clock }))('D-021 — a later-day price reaches the tills on its day by itself — on $name', ({ harness }) => {
  async function shop() {
    offsetMs = 0;
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await aBranch(h, T, 'u-owner');
    await storeRules(h, T, 'u-owner', 'store-1', 0);
    await mrpOnRecord(h, T, 'u-owner', 'p-biscuit', 3_500);
    await mrpOnRecord(h, T, 'u-owner', 'p-salt', 2_500);
    const req = (method: 'GET' | 'POST', path: string, who: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId: who, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const pack = async () => { const r = await req('GET', '/v1/catalogue/pack', 'u-owner'); return r.status === 200 ? r.body as Pack : undefined; };
    const notSent = async () => (await req('GET', '/v1/catalogue/pack/not-sent', 'u-owner', undefined, { storeId: 'store-1' })).body as { count: number; notSent: { productId: string; reason: string; startsOn?: string }[] };
    const entry = (productId: string, priceMinor: number, mrpMinor: number, effectiveFrom: string) => req('POST', `/v1/prices/list/${productId}/entries/e-${randomUUID()}`, 'u-owner', { scope: 'store', scopeRef: 'store-1', priceMinor, mrpMinor, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom });
    const change = (productId: string, priceMinor: number, mrpMinor: number) => req('POST', '/v1/prices/changes', 'u-mgr', { productId, priceMinor, mrpMinor, costMinor: 1_000, currency: 'INR', marginFloorBps: 0 });
    return { h, T, pack, notSent, entry, change };
  }
  const priceOf = (p: Pack | undefined, id: string) => p?.snapshot.products.find((x) => x.productId === id)?.unitPriceMinor;
  const shopDay = (plusDays: number) => shopDateIn(new Date(Date.now() + plusDays * DAY).toISOString());

  it('saved for tomorrow: not sent today; tomorrow the store computer\'s ask brings it — once, with no button', async () => {
    const { pack, notSent, entry, change, h, T } = await shop();
    const now = await change('p-salt', 2_400, 2_500); // today's price first, so the store has a pack
    expect(now.body).toMatchObject({ tills: [{ sent: true, version: 1 }] });
    const later = await entry('p-salt', 2_200, 2_500, shopDay(1));
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    expect(later.body).toMatchObject({ tills: [{ sent: false, reason: 'starts_later' }] });

    // TODAY: the store computer asks — nothing is sent early.
    const today = await pack();
    expect(today?.snapshot.version).toBe(1);
    expect(priceOf(today, 'p-salt')).toBe(2_400);
    expect(await notSent()).toMatchObject({ count: 1, notSent: [{ productId: 'p-salt', reason: 'starts_later', startsOn: shopDay(1) }] });

    // TOMORROW: the clock moves past the start day; the store computer's normal ask carries the new price.
    offsetMs = DAY + 60_000;
    const tomorrow = await pack();
    expect(tomorrow?.snapshot.version).toBe(2);
    expect(priceOf(tomorrow, 'p-salt')).toBe(2_200);
    expect((await notSent()).count).toBe(0);
    // Never twice: the next asks find nothing to send — the same version stays.
    expect((await pack())?.snapshot.version).toBe(2);
    expect((await pack())?.snapshot.version).toBe(2);
    // The trail says what went.
    const trail = ((await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'store', objectId: 'store-1' } })).body as { matches: { action: string; after: Record<string, string> }[] }).matches;
    expect(trail.filter((m) => m.action === 'catalogue.pack.sent_on_start_day').map((m) => [m.after['productIds'], m.after['packVersion']])).toEqual([['p-salt', '2']]);
  });

  it('a pack sent today for another price does NOT settle a price that starts later — it stays listed until its own day', async () => {
    const { pack, notSent, entry, change } = await shop();
    await entry('p-salt', 2_200, 2_500, shopDay(2));
    const other = await change('p-biscuit', 3_000, 3_500);
    expect(other.body).toMatchObject({ tills: [{ sent: true, version: 1 }] });
    // That pack could not carry the later price — the list still says so (P-08).
    expect(await notSent()).toMatchObject({ count: 1, notSent: [{ productId: 'p-salt', reason: 'starts_later' }] });
    // One day on: still not its day — nothing is sent early.
    offsetMs = DAY + 60_000;
    expect((await pack())?.snapshot.version).toBe(1);
    expect((await notSent()).count).toBe(1);
    // Its day: it goes, and the earlier price is still there.
    offsetMs = 2 * DAY + 60_000;
    const p = await pack();
    expect(p?.snapshot.version).toBe(2);
    expect(priceOf(p, 'p-salt')).toBe(2_200);
    expect(priceOf(p, 'p-biscuit')).toBe(3_000);
    expect((await notSent()).count).toBe(0);
  });
});
