import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TEST_PACK_KEY } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import { acceptPack, canonicalise, type SignedPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { CatalogueCache, ExpiredItemError } from '../../packages/catalogue/src/catalogue';
import { expirySweepThatPublishes } from '../../services/api/src/followups-adapters';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **M10-FR-01 · B8 — the integration follow-up: the expired-batch state reaches the till.** Lane 2 · P2's daily expiry move
 * puts a batch past its date in the EXPIRED state (`BatchExpired`). Now head office carries those batches on the signed
 * pack the tills trade on, the moment the move runs: a scan whose barcode CARRIES the expired batch (a GS1 2D code with
 * its batch and no date) is refused by name at the lane, offline, whatever the lane's clock reads; its sibling batch
 * sells; a PLAIN barcode is not refused by this list (OB-298: the cashier confirms a flagged perishable's printed date —
 * the till builder's tap). The list rides under the signature; the sale-blocks register says it is on the pack. Every
 * scan is `acceptPack` + `CatalogueCache.scan`, the lane's own code, with no network. In memory and on real PostgreSQL,
 * with a cold restart.
 */

const backings = useRestartableBackings();
const STORE = 'store-01';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const signer = hmacSigner(TEST_PACK_KEY);
const CURD = '8901000000026';
const twoD = (batch: string): string => `(01)0${CURD}(10)${batch}`;
type Res = { status: number; body: unknown };
const day = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe.each(backings)('an expired batch is refused on its batch barcode, offline (M10-FR-01 follow-up) — on $name', ({ harness }) => {
  it('the expiry move puts B-OLD on the tills\' pack: its 2D code is refused, B-NEW sells, the plain barcode sells; signed; a restart reads the same', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-qc', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(req('POST', '/v1/catalogue/tax-classes/04031000/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/catalogue/products/p-curd/publish', { product: { sku: 'SKU-CURD', name: 'Curd 400g', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04031000', lifecycle: 'draft' }, categories: [GROCERY] }), 'publish curd');
    await ok(req('POST', '/v1/prices/list/p-curd/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 6_000, mrpMinor: 6_500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: shopDateIn(new Date().toISOString()) }), 'price');
    await ok(req('POST', `/v1/catalogue/products/p-curd/barcodes/${CURD}`, { kind: 'ean' }), 'barcode');
    // Two batches on the shelf: B-OLD past its date two days ago, B-NEW good for a week.
    for (const [b, expiry] of [['B-OLD', day(-2)], ['B-NEW', day(7)]] as const) {
      await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${b}`, productId: 'p-curd', locationId: STORE, kind: 'received', quantityMinor: 12, uom: 'EA', occurredAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), enteredBy: 'u-owner', batchId: b, expiry }), `receive ${b}`);
    }
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: shopDateIn(new Date().toISOString()) }), 'first pack');

    let held: SignedPack | undefined;
    const lane = async (): Promise<CatalogueCache> => {
      const incoming = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
      const accepted = acceptPack({ incoming, ...(held === undefined ? {} : { held }), signer, tenantId: T });
      expect(accepted.accepted, accepted.detail).toBe(true);
      held = accepted.tradingOn!;
      return new CatalogueCache(held.snapshot);
    };
    // Before the move: the lane cannot tell B-OLD from B-NEW on a code with no date — both ring.
    const before = await lane();
    expect(before.scan(twoD('B-OLD')).product.productId).toBe('p-curd');
    const sb0 = (await req('GET', '/v1/quality/sale-blocks')).body as { expiredBatches: unknown[] };
    expect(sb0.expiredBatches).toEqual([]);

    // The daily expiry move runs (the ops-alert worker's pass); it re-signs the tills' pack with B-OLD on it.
    const at = new Date().toISOString();
    expect(await expirySweepThatPublishes({ store: h.store, now: () => at, signer })(T, at)).toBe(1);

    h = harness(h); // ── cold restart ──
    const after = await lane();
    const curd = held!.snapshot.products.find((p) => p.productId === 'p-curd')!;
    expect(curd.expiredBatches).toEqual([{ batchId: 'B-OLD', expiry: day(-2) }]);
    expect(curd.unitPriceMinor).toBe(6_000); // prices untouched
    expect(curd.recallBlock === true).toBe(false); // not a recall: the plain barcode is not blocked by it
    // Offline, at the lane: the expired batch's own code is refused by name; its sibling sells; the plain barcode sells.
    expect(() => after.scan(twoD('B-OLD'))).toThrow(ExpiredItemError);
    expect(() => after.scan(twoD('B-OLD'))).toThrow(/Curd 400g" is past its use-by date/);
    expect(after.scan(twoD('B-NEW')).batch).toMatchObject({ batchId: 'B-NEW' });
    expect(after.scan(CURD).product.productId).toBe('p-curd');
    // Head office's register says the till has it.
    const sb = (await req('GET', '/v1/quality/sale-blocks')).body as { expiredBatches: { productId: string; batchId: string; state: string; atTheTill: string }[]; expiredNotYetOnPack: number };
    expect(sb.expiredBatches).toEqual([{ productId: 'p-curd', batchId: 'B-OLD', expiry: day(-2), state: 'on_pack', atTheTill: 'batch_barcode_refused_plain_barcode_cashier_confirms_date' }]);
    expect(sb.expiredNotYetOnPack).toBe(0);
    expect((await req('GET', '/v1/quality/sale-blocks', undefined, 'u-cash')).status).toBe(403);

    // The list rides under the signature: a pack edited to let B-OLD sell again does not verify; the lane keeps its pack.
    const tampered: SignedPack = { ...held!, snapshot: { ...held!.snapshot, version: held!.snapshot.version + 1, products: held!.snapshot.products.map((p) => (p.productId === 'p-curd' ? { ...p, expiredBatches: [] } : p)) } };
    expect(acceptPack({ incoming: tampered, held: held!, signer, tenantId: T })).toMatchObject({ accepted: false, rejectedBecause: 'signature_does_not_verify' });
    expect(canonicalise(held!.snapshot)).toContain('--expired');

    // A second pass the same day moves nothing and publishes nothing new; an ordinary full publish keeps the batch on.
    const version = held!.snapshot.version;
    expect(await expirySweepThatPublishes({ store: h.store, now: () => at, signer })(T, at)).toBe(0);
    expect(((await req('GET', '/v1/catalogue/pack')).body as SignedPack).snapshot.version).toBe(version);
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: shopDateIn(new Date().toISOString()) }), 'full publish');
    const full = await lane();
    expect(() => full.scan(twoD('B-OLD'))).toThrow(ExpiredItemError);
    // Run by hand, the move says what it did to the tills' pack too.
    const byHand = (await ok(req('POST', '/v1/inventory/expiry-sweep', {}, 'u-qc'), 'sweep by hand')).body as { count: number; tillsPack: { published: boolean; why?: string } };
    expect(byHand).toMatchObject({ count: 0, tillsPack: { published: false, why: 'already_on_pack' } });
  }, 120_000);
});
