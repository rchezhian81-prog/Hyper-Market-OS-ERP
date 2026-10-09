import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { aBranch } from '../support/a-branch';
import { canonicalise } from '../../services/catalogue/src/pack';
import { PosSession, taxRateFromPercent } from '../../apps/pos/src/index';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **SF-01 (offers) — an offer launched at head office is the offer the till gives (Wave 4 · M05-FR-03 · M05-FR-04 ·
 * P-01 offline first · P-02 one commerce truth).**
 *
 * The audit found three breaks between the offer screen and the till: a launch only RECORDED the launch (the rule the
 * lanes read stayed a draft); `/activate` switched an offer on with no margin check and no second person; and the
 * catalogue pack never carried offers at all — the till's offer engine was never loaded and judged every offer at
 * 1 Jan 1970. Now: a launch switches the defined rule on in the same append; `/activate` refuses an unlaunched offer;
 * the pack carries the switched-on offers under its signature; and the till loads them and judges them by its own clock.
 * This follows one offer all the way: define → launch → published pack → the till's total.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TODAY = new Date().toISOString().slice(0, 10);
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString();
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const MARGIN_OK = { description: '10% off salt', normalPrice: { minor: 2_000, currency: 'INR' }, promoPrice: { minor: 1_800, currency: 'INR' }, unitCost: { minor: 1_000, currency: 'INR' }, baselineUnits: 100, expectedUnits: 200 };
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

type Req = (method: 'POST' | 'GET', path: string, body?: unknown, key?: string) => Promise<{ status: number; body: unknown }>;
async function shop(): Promise<{ h: ApiHarness; req: Req }> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  const req: Req = (method, path, body, key = `k-${Math.random()}`) =>
    h.request({ method, path, userId: 'u-owner', tenantId: A, ...(method === 'POST' ? { idempotencyKey: key } : {}), ...(body === undefined ? {} : { body }) });
  await aBranch(h, A, 'u-owner', 'store-1');
  expect((await req('POST', '/v1/catalogue/products/p-salt/publish', { product: { sku: 'SKU-SALT', name: 'Tata Salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' }, categories: [GROCERY] })).status).toBeLessThan(300);
  expect((await req('POST', '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', { rateBps: 500 })).status).toBeLessThan(300);
  expect((await req('POST', '/v1/prices/list/p-salt/entries/e1', { scope: 'store', scopeRef: 'store-1', priceMinor: 2_000, mrpMinor: 2_500, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY })).status).toBe(201);
  return { h, req };
}
const define = (req: Req, id: string, over: Record<string, unknown> = {}) =>
  req('POST', `/v1/promotions/${id}/definition`, { kind: 'percent_off', percentBps: 1000, productIds: ['p-salt'], startsAt: day(-1), endsAt: day(30), ...over }, `def-${id}`);
const launch = (req: Req, id: string, key = `launch-${id}`) => req('POST', `/v1/promotions/${id}/launch`, MARGIN_OK, key);
const publishPack = async (req: Req): Promise<CatalogueSnapshot> => {
  expect((await req('POST', '/v1/catalogue/pack', { storeId: 'store-1' })).status).toBe(201);
  return ((await req('GET', '/v1/catalogue/pack')).body as { snapshot: CatalogueSnapshot }).snapshot;
};

/** A real till session, built as the lane boots it: the pack's offers loaded, judged by the lane's own clock. */
function tillOn(snapshot: CatalogueSnapshot): PosSession {
  const session = new PosSession(
    { laneId: 'lane-1', cashierId: 'u-cash', currency: 'INR', defaultTaxRate: taxRateFromPercent(5), clock: () => new Date().toISOString() },
    new Ledger(new InMemoryLedgerStore()),
    new SyncOutbox(),
    () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
  );
  session.loadPromotions(snapshot.promotions ?? []);
  return session;
}
const ringUpSalt = (session: PosSession, snapshot: CatalogueSnapshot, qty: number): number => {
  const p = snapshot.products.find((x) => x.productId === 'p-salt')!;
  session.scan({ productId: p.productId, description: 'Tata Salt 1kg', unitPrice: money(p.unitPriceMinor, 'INR'), quantityMinor: qty, uom: 'ea' });
  return session.totals().payable.minor;
};

describe('SF-01 (offers) — a launched offer reaches the till', () => {
  it('THE AUDIT\'S CASE: define → launch → the next pack carries the offer → the till takes 10% off 3 × ₹20', async () => {
    const { req } = await shop();
    expect((await define(req, 'salt-10')).status).toBe(201);
    // defined but not launched: no pack carries it, and the till charges full price
    const before = await publishPack(req);
    expect(before.promotions).toBeUndefined();
    expect(ringUpSalt(tillOn(before), before, 3)).toBe(6_000);

    const launched = await launch(req, 'salt-10');
    expect(launched.status).toBe(201);
    const pack = await publishPack(req);
    expect(pack.promotions).toEqual([expect.objectContaining({ id: 'salt-10', status: 'active', percentBps: 1000, productIds: ['p-salt'] })]);
    // The till, offline from here, gives the offer: ₹60 − 10% = ₹54.
    expect(ringUpSalt(tillOn(pack), pack, 3)).toBe(5_400);
  });

  it('the offer rides under the pack signature — a pack with the offer stripped no longer matches what was signed', async () => {
    const { req } = await shop();
    await define(req, 'salt-10');
    await launch(req, 'salt-10');
    const pack = await publishPack(req);
    const stripped: CatalogueSnapshot = { ...pack };
    delete (stripped as { promotions?: unknown }).promotions;
    expect(canonicalise(stripped)).not.toBe(canonicalise(pack));
    // …and one with the offer made bigger does not either
    const bigger = { ...pack, promotions: pack.promotions!.map((p) => ({ ...p, percentBps: 5000 })) } as CatalogueSnapshot;
    expect(canonicalise(bigger)).not.toBe(canonicalise(pack));
  });

  it('switching an offer on without its launch check is refused; it never reaches a pack', async () => {
    const { req } = await shop();
    await define(req, 'salt-10');
    const res = await req('POST', '/v1/promotions/salt-10/activate', {});
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('promotion_not_launched');
    expect((await publishPack(req)).promotions).toBeUndefined();
  });

  it('a launch with no defined rule is refused by name — nothing is launched', async () => {
    const { req } = await shop();
    const res = await launch(req, 'ghost');
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('promotion_not_defined');
    expect(((await req('GET', '/v1/promotions/ghost')).body as { launched: boolean }).launched).toBe(false);
  });

  it('a stopped offer leaves the next pack; a draft stopped before launch cannot be launched back on', async () => {
    const { req } = await shop();
    await define(req, 'salt-10');
    await launch(req, 'salt-10');
    expect((await req('POST', '/v1/promotions/salt-10/stop', {})).status).toBe(200);
    const pack = await publishPack(req);
    expect(pack.promotions).toBeUndefined();
    expect(ringUpSalt(tillOn(pack), pack, 3)).toBe(6_000);

    await define(req, 'salt-5', { percentBps: 500 });
    await req('POST', '/v1/promotions/salt-5/stop', {});
    expect(codeOf(await launch(req, 'salt-5'))).toBe('promotion_stopped');
  });

  it('an offer whose window has ended is not carried; one not yet started is carried but the till does not give it yet', async () => {
    const { req } = await shop();
    await define(req, 'ended', { startsAt: day(-10), endsAt: day(-1) });
    await launch(req, 'ended');
    await define(req, 'next-week', { startsAt: day(7), endsAt: day(14) });
    await launch(req, 'next-week');
    const pack = await publishPack(req);
    expect((pack.promotions ?? []).map((p) => p.id)).toEqual(['next-week']);
    // the lane judges the window by its own clock: today, no discount
    expect(ringUpSalt(tillOn(pack), pack, 3)).toBe(6_000);
  });
});
