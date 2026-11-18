import { describe, it, expect } from 'vitest';
import {
  catalogueRoutes, hmacSigner, sendAcceptedPriceToTills, sendPricesNowInForce,
  type CatalogueDeps, type SignedPack,
} from '../../services/catalogue/src/index';
import type { CatalogueProduct, CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { notSentLogAdapter } from '../../services/api/src/till-delivery';

// Daily-work defect D-021 (owner, 18 Nov 2026, under OB-801): a price accepted for a LATER day goes to the tills by itself
// on its start day, through the SAME signed pack publish — never early, never twice, never past a check the owner's button
// would ask for, and the not-sent list stays honest (P-08).

const T = 'tenant-d021';
const signer = hmacSigner('d021-test-signing-secret-of-enough-length');
const product = (id: string, price: number): CatalogueProduct =>
  ({ productId: id, sku: `SKU-${id}`, name: id, baseUom: 'each', unitPriceMinor: price, taxBps: 500, mrpMinor: 5_000, status: 'active' });

function shop(prices: Map<string, number>, over: Partial<CatalogueDeps> = {}) {
  let now = '2026-11-16T06:00:00.000Z'; // 11:30 in the shop
  const packs: SignedPack[] = [];
  const deps: CatalogueDeps = {
    signer, now: () => now,
    currentPack: () => packs[packs.length - 1],
    storePack: (_t, pack) => { packs.push(pack); },
    buildSnapshot: (tenantId, options): CatalogueSnapshot => ({
      tenantId, version: (packs[packs.length - 1]?.snapshot.version ?? 0) + 1, builtAt: now,
      scope: { tenantId, storeId: options.storeId ?? 'store-1' },
      products: [...prices].map(([id, p]) => product(id, p)), barcodes: [],
    }),
    approvalsSince: () => [],
    notSent: notSentLogAdapter({ store: new InMemoryEventStore() }),
    ...over,
  };
  return { deps, packs, setNow: (iso: string) => { now = iso; } };
}
const later = (deps: CatalogueDeps, startsOn: string, productId = 'salt') =>
  sendAcceptedPriceToTills(deps, T, { storeId: 'store-1', productId, priceMinor: 1_800, by: 'u-owner', startsOn, today: '2026-11-16', withinMinutes: 5 });

describe('D-021 — a later-day price goes to the tills on its start day by itself', () => {
  it('never early: before its day nothing is signed, and it stays on the list with its day', async () => {
    const s = shop(new Map([['salt', 1_800]]));
    expect(await later(s.deps, '2026-11-18')).toMatchObject({ sent: false, reason: 'starts_later' });
    expect(await sendPricesNowInForce(s.deps, T, { today: '2026-11-17', withinMinutes: 5 })).toEqual([]);
    expect(s.packs).toEqual([]);
    expect(await s.deps.notSent!.since(T, 'store-1')).toMatchObject([{ productId: 'salt', reason: 'starts_later', startsOn: '2026-11-18' }]);
  });

  it('on its day it goes once through the signed publish, signed by the person who set it; the next check finds nothing', async () => {
    const s = shop(new Map([['salt', 1_800]]));
    await later(s.deps, '2026-11-18');
    s.setNow('2026-11-18T02:00:00.000Z');
    const sent = await sendPricesNowInForce(s.deps, T, { today: '2026-11-18', withinMinutes: 5 });
    expect(sent).toMatchObject([{ storeId: 'store-1', sent: true, version: 1, productIds: ['salt'] }]);
    expect(s.packs[0]!.publishedBy).toBe('u-owner');
    expect(await s.deps.notSent!.since(T, 'store-1')).toEqual([]);
    expect(await sendPricesNowInForce(s.deps, T, { today: '2026-11-18', withinMinutes: 5 })).toEqual([]);
    expect(await sendPricesNowInForce(s.deps, T, { today: '2026-11-19', withinMinutes: 5 })).toEqual([]);
    expect(s.packs).toHaveLength(1);
  });

  it('a pack that goes today keeps a price that starts later on the list (it could not carry it)', async () => {
    const s = shop(new Map([['salt', 1_800], ['dal', 2_000]]));
    await later(s.deps, '2026-11-20');
    await later(s.deps, '2026-11-16', 'dal'); // today's — goes now
    expect(s.packs).toHaveLength(1);
    expect(await s.deps.notSent!.since(T, 'store-1')).toMatchObject([{ productId: 'salt', startsOn: '2026-11-20' }]);
  });

  it('on its day, a send that needs the owner\'s two-step sign-in is NOT signed — recorded ONCE as waiting for the owner', async () => {
    const prices = new Map(Array.from({ length: 30 }, (_, i) => [`p${i}`, 1_000 + i] as const));
    const s = shop(prices, { bulkPublishThreshold: () => 5 });
    await later(s.deps, '2026-11-18', 'p1');
    s.setNow('2026-11-18T02:00:00.000Z');
    expect(await sendPricesNowInForce(s.deps, T, { today: '2026-11-18', withinMinutes: 5 })).toMatchObject([{ sent: false, reason: 'needs_the_owner' }]);
    expect(await sendPricesNowInForce(s.deps, T, { today: '2026-11-18', withinMinutes: 5 })).toEqual([]); // not retried each ask
    expect(s.packs).toEqual([]);
    expect((await s.deps.notSent!.since(T, 'store-1')).map((e) => e.reason)).toEqual(['starts_later', 'needs_the_owner']);
  });

  it('the store computer\'s pack ask runs the check first; two asks together send it once', async () => {
    const s = shop(new Map([['salt', 1_800]]));
    await later(s.deps, '2026-11-18');
    s.setNow('2026-11-18T02:00:00.000Z');
    const deps: CatalogueDeps = { ...s.deps, startDaySend: (t) => sendPricesNowInForce(s.deps, t, { today: '2026-11-18', withinMinutes: 5 }) };
    const read = catalogueRoutes(deps).find((r) => r.method === 'GET' && r.path === '/v1/catalogue/pack')!;
    const ctx = { tenantId: T, userId: 'box', branchId: null, query: {}, params: {}, body: undefined, traceId: 't', permissions: [] } as unknown as Parameters<typeof read.handler>[0];
    const [a, b] = await Promise.all([read.handler(ctx), read.handler(ctx)]);
    expect((a.body as SignedPack).snapshot.version).toBe(1);
    expect((b.body as SignedPack).snapshot.version).toBe(1);
    expect(s.packs).toHaveLength(1);
  });

  it('a failing check never breaks the pack read', async () => {
    const s = shop(new Map([['salt', 1_800]]));
    s.packs.push({ snapshot: { tenantId: T, version: 1, builtAt: 'x', products: [], barcodes: [] } } as unknown as SignedPack);
    const read = catalogueRoutes({ ...s.deps, startDaySend: () => Promise.reject(new Error('down')) }).find((r) => r.method === 'GET' && r.path === '/v1/catalogue/pack')!;
    const res = await read.handler({ tenantId: T, query: {}, params: {} } as unknown as Parameters<typeof read.handler>[0]);
    expect(res.status).toBe(200);
  });
});
