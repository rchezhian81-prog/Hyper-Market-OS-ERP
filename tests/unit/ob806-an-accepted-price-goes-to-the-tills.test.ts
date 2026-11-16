import { describe, it, expect } from 'vitest';
import {
  catalogueRoutes, hmacSigner, sendAcceptedPriceToTills, verifyAsLane,
  type CatalogueDeps, type NotSentLog, type NotSentToTills, type SignedPack,
} from '../../services/catalogue/src/index';
import type { CatalogueProduct, CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { tillsSentence, tillDeliveriesOf } from '../../apps/web-erp/src/catalogue-session';
import { storePullMaxMinutes } from '../../packages/sync/src/pull-timing';

// OB-806 A (owner, 16 Nov 2026, in writing) · daily-work defect D-021: a price head office ACCEPTED goes to the store's tills
// at once — through the SAME signed, versioned, append-only pack publish as "Send to the tills". It never signs past a check
// the button would ask for (the owner's fresh two-step sign-in for a bulk or regulated publish; the pack's own refusals), and
// a price not sent is recorded and said, never silent (P-08).

const T = 'tenant-ob806';
const NOW = '2026-11-16T09:00:00.000Z';
const signer = hmacSigner('ob806-a-test-signing-secret-of-enough-length');
const product = (id: string, price: number, over: Partial<CatalogueProduct> = {}): CatalogueProduct =>
  ({ productId: id, sku: `SKU-${id}`, name: id, baseUom: 'each', unitPriceMinor: price, taxBps: 500, mrpMinor: 5_000, status: 'active', ...over });

/** A shop whose head-office prices are `prices`; packs are kept append-only in `packs`. */
function shop(prices: Map<string, number>, over: Partial<CatalogueDeps> = {}) {
  const packs: SignedPack[] = [];
  const notSent: NotSentToTills[] = [];
  const sent: { storeId: string; version: number }[] = [];
  const log: NotSentLog = {
    recordNotSent: (_t, e) => { notSent.push(e); },
    recordSent: (_t, storeId, version) => { sent.push({ storeId, version }); },
    since: (_t, storeId) => {
      const lastSent = sent.filter((s) => s.storeId === storeId).length;
      return lastSent === 0 ? notSent.filter((e) => e.storeId === storeId) : [];
    },
  };
  const deps: CatalogueDeps = {
    signer, now: () => NOW,
    currentPack: () => packs[packs.length - 1],
    storePack: (_t, pack) => { packs.push(pack); },
    buildSnapshot: (tenantId, options): CatalogueSnapshot => ({
      tenantId, version: (packs[packs.length - 1]?.snapshot.version ?? 0) + 1, builtAt: NOW,
      scope: { tenantId, storeId: options.storeId ?? 'store-1' },
      products: [...prices].map(([id, p]) => product(id, p)), barcodes: [],
    }),
    approvalsSince: () => [],
    notSent: log,
    ...over,
  };
  return { deps, packs, notSent, sent };
}
const send = (deps: CatalogueDeps, over: Partial<Parameters<typeof sendAcceptedPriceToTills>[2]> = {}) =>
  sendAcceptedPriceToTills(deps, T, { storeId: 'store-1', productId: 'salt', priceMinor: 1_800, by: 'u-mgr', startsOn: '2026-11-16', today: '2026-11-16', withinMinutes: storePullMaxMinutes(), ...over });

describe('OB-806 A — an accepted price is sent to the tills through the one pack publish', () => {
  it('an accepted price publishes a NEW signed pack for the store that carries it — the lane verifies it', async () => {
    const prices = new Map([['salt', 2_000], ['rice', 4_000]]);
    const s = shop(prices);
    expect(await send(s.deps, { priceMinor: 2_000 })).toMatchObject({ sent: true, version: 1 }); // the first pack: ₹20
    prices.set('salt', 1_800); // head office accepted ₹18
    const d = await send(s.deps);
    expect(d).toEqual({ storeId: 'store-1', sent: true, version: 2, withinMinutes: storePullMaxMinutes() });
    expect(s.packs.map((p) => p.snapshot.version)).toEqual([1, 2]); // append-only: v1 stays, v2 is added
    const v2 = s.packs[1]!;
    expect(v2.snapshot.products.find((p) => p.productId === 'salt')?.unitPriceMinor).toBe(1_800);
    expect(v2.publishedBy).toBe('u-mgr'); // the person whose accepted price sent it
    expect(verifyAsLane(v2, signer)).toBe(true);
    expect(s.sent).toEqual([{ storeId: 'store-1', version: 1 }, { storeId: 'store-1', version: 2 }]);
    expect(s.notSent).toEqual([]);
  });

  it('a send that would need the owner\'s fresh two-step sign-in (bulk or regulated) is NOT signed — it waits for the owner, said', async () => {
    const prices = new Map(Array.from({ length: 30 }, (_, i) => [`p${i}`, 1_000 + i] as const));
    const s = shop(prices, { bulkPublishThreshold: () => 5 });
    const d = await send(s.deps, { productId: 'p1', priceMinor: 1_001 });
    expect(d).toMatchObject({ sent: false, reason: 'needs_the_owner' });
    expect(d.sent === false && d.why).toMatch(/two-step sign-in/);
    expect(s.packs).toEqual([]); // nothing signed
    expect(s.notSent).toMatchObject([{ storeId: 'store-1', productId: 'p1', priceMinor: 1_001, reason: 'needs_the_owner', by: 'u-mgr' }]);
  });

  it('a send the pack\'s own checks refuse (an empty pack) is NOT stored — recorded as not sent with the reason', async () => {
    const s = shop(new Map());
    const d = await send(s.deps);
    expect(d).toMatchObject({ sent: false, reason: 'refused' });
    expect(s.packs).toEqual([]);
    expect(s.notSent).toHaveLength(1);
  });

  it('a failure to build or store is never silent: not sent, said, recorded', async () => {
    const s = shop(new Map([['salt', 1_800]]), { storePack: () => { throw new Error('disk full'); } });
    const d = await send(s.deps);
    expect(d).toMatchObject({ sent: false, reason: 'failed' });
    expect(d.sent === false && d.why).toMatch(/disk full/);
    expect(s.notSent).toMatchObject([{ reason: 'failed' }]);
  });

  it('a price that starts on a later day is not in today\'s pack — it waits for its day, said', async () => {
    const s = shop(new Map([['salt', 1_800]]));
    const d = await send(s.deps, { startsOn: '2026-11-20' });
    expect(d).toMatchObject({ sent: false, reason: 'starts_later' });
    expect(s.packs).toEqual([]);
  });

  it('"Send to the tills" by hand settles the not-sent list; the owner\'s page reads it from GET /v1/catalogue/pack/not-sent', async () => {
    const s = shop(new Map([['salt', 1_800]]), { storePack: () => { throw new Error('disk full'); } });
    await send(s.deps);
    const routes = catalogueRoutes(s.deps);
    const notSentRoute = routes.find((r) => r.method === 'GET' && r.path === '/v1/catalogue/pack/not-sent')!;
    const ctx = (query: Record<string, string>) => ({ tenantId: T, userId: 'u-owner', branchId: null, query, params: {}, body: undefined, traceId: 't', permissions: [] }) as unknown as Parameters<typeof notSentRoute.handler>[0];
    expect((await notSentRoute.handler(ctx({ storeId: 'store-1' }))).body).toMatchObject({ count: 1, notSent: [{ productId: 'salt', reason: 'failed' }] });
    expect(notSentRoute.permission).toBe('catalogue.pack.read');
    // the store's pack goes (by hand, or the next automatic send): the list is settled
    const ok = shop(new Map([['salt', 1_800]]));
    ok.deps.notSent!.recordNotSent(T, { storeId: 'store-1', productId: 'salt', priceMinor: 1_800, reason: 'failed', why: 'x', by: 'u-mgr', at: NOW });
    expect(await ok.deps.notSent!.since(T, 'store-1')).toHaveLength(1);
    const publish = catalogueRoutes(ok.deps).find((r) => r.method === 'POST' && r.path === '/v1/catalogue/pack')!;
    const res = await publish.handler({ ...ctx({}), body: { storeId: 'store-1' } } as unknown as Parameters<typeof publish.handler>[0]);
    expect(res.status).toBe(201);
    expect(await ok.deps.notSent!.since(T, 'store-1')).toEqual([]);
  });
});

describe('OB-806 A — the manager is told what happened at the tills, in words', () => {
  it('sent: "the tills will have it within 5 minutes"; not sent: head office\'s reason, and that the old price stands', () => {
    expect(tillsSentence('en', [{ storeId: 's', sent: true, version: 4, withinMinutes: 5 }])).toEqual({ text: 'Saved — the tills will have it within 5 minutes.', good: true });
    const missed = tillsSentence('en', [{ storeId: 's', sent: false, reason: 'needs_the_owner', why: 'It waits for the owner.' }]);
    expect(missed.good).toBe(false);
    expect(missed.text).toContain('NOT reached the tills');
    expect(missed.text).toContain('It waits for the owner.');
    expect(missed.text).toContain('old price');
    expect(tillsSentence('en', [{ storeId: 's', sent: false, reason: 'starts_later', why: '' }]).good).toBe(true);
    expect(tillsSentence('en', null).text).toMatch(/Send to the tills/);
    expect(tillsSentence('ta', [{ storeId: 's', sent: true, version: 4, withinMinutes: 5 }]).text).toContain('5');
  });

  it('reads head office\'s `tills` strictly: anything unreadable is "not said", never a false "sent"', () => {
    expect(tillDeliveriesOf([{ storeId: 's', sent: true, version: 3, withinMinutes: 5 }])).toEqual([{ storeId: 's', sent: true, version: 3, withinMinutes: 5 }]);
    expect(tillDeliveriesOf([{ storeId: 's', sent: true }])).toBeNull(); // no version → not believed
    expect(tillDeliveriesOf('yes')).toBeNull();
    expect(tillDeliveriesOf(undefined)).toBeNull();
  });
});
