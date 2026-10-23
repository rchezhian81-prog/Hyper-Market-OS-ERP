import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { acceptPack, canonicalise, type SignedPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { CatalogueCache, RecalledItemError, ExpiredItemError } from '../../packages/catalogue/src/catalogue';

/**
 * **SF-08 (R3, OB-139 "A") and D-20 through the real API and the lane's own trust path — in memory and on real
 * PostgreSQL, with a cold restart.** Signed sentence: "with batch B-1 of paneer recalled and B-2 not, a scan carrying B-1
 * is refused by name offline and a scan carrying B-2 sells. A scan with no batch follows the Q3 answer [OB-139: block the
 * whole product]. Closing the recall with evidence lifts the B-1 block on the next pack."
 *
 * And D-20's markdown: a batch whose markdown price went through the price list's own gate (MRP, margin floor) is charged
 * that price when its 2D code is scanned — and only then. Every scan below is `acceptPack` + `CatalogueCache.scan`: the
 * lane's code, no network.
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
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

const STORE = 'store-01';
const AS_OF = '2030-06-10';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const signer = hmacSigner(TEST_PACK_KEY);
const PANEER = '8901000000019';
const PANEER_GTIN = `0${PANEER}`;
const CURD = '8901000000026';
const twoD = (batch: string, expiry = '300615'): string => `(01)${PANEER_GTIN}(17)${expiry}(10)${batch}`;
type Res = { status: number; body: unknown };

describe.each(backings)('SF-08 · D-20: a recalled batch is refused and its sibling sells, offline — on $name', ({ harness, restart }) => {
  it('B-1 recalled: its 2D code refused by name, B-2 sells, a plain barcode blocks paneer; closed with evidence → B-1 sells on the next pack', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 }), 'tax');
    for (const [id, sku, name, code] of [['p-paneer', 'SKU-PANEER', 'Paneer 200g', PANEER], ['p-curd', 'SKU-CURD', 'Curd 400g', CURD]] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft' }, categories: [GROCERY] }), `publish ${id}`);
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: 9_000, mrpMinor: 9_500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
      await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }), `barcode ${id}`);
    }
    for (const b of ['B-1', 'B-2', 'B-3']) {
      await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${b}`, productId: 'p-paneer', locationId: STORE, kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: b, expiry: '2030-06-15' }), `receive ${b}`);
    }
    // D-20: batch B-3 is marked down to ₹45 through the price list's own gate (MRP and margin floor still apply).
    await ok(req('POST', '/v1/prices/list/p-paneer/entries/md-B-3', { scope: 'store', scopeRef: STORE, priceMinor: 4_500, mrpMinor: 9_500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-06-01', batchId: 'B-3' }), 'markdown B-3');
    // A markdown above the printed MRP is refused like any price — no batch makes the legal ceiling move.
    expect((await req('POST', '/v1/prices/list/p-paneer/entries/md-bad', { scope: 'store', scopeRef: STORE, priceMinor: 9_900, mrpMinor: 9_500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-06-01', batchId: 'B-2' })).status).toBe(422);

    let held: SignedPack | undefined;
    let n = 0;
    const lane = async (): Promise<CatalogueCache> => {
      n += 1;
      await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), `publish pack ${n}`);
      const incoming = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
      const accepted = acceptPack({ incoming, ...(held === undefined ? {} : { held }), signer, tenantId: T });
      expect(accepted.accepted, accepted.detail).toBe(true);
      held = accepted.tradingOn!;
      return new CatalogueCache(held.snapshot);
    };
    const today = { asOf: AS_OF };

    const v1 = await lane();
    // The markdown reaches the lane: B-3's 2D code is charged ₹45; the plain barcode and B-2 are charged ₹90.
    expect(v1.scan(twoD('B-3'), today).markdownPriceMinor).toBe(4_500);
    expect(v1.scan(twoD('B-2'), today).markdownPriceMinor).toBeUndefined();
    expect(v1.scan(PANEER, today).product.unitPriceMinor).toBe(9_000);
    // An expired batch is refused at the lane (B8), from the date its own code carries.
    expect(() => v1.scan(twoD('B-2', '300609'), today)).toThrow(ExpiredItemError);

    // The recall is initiated on B-1 only.
    await ok(req('POST', '/v1/quality/recalls/B-1', { reason: 'supplier contamination notice' }), 'recall B-1');
    const blocks = (await req('GET', '/v1/quality/sale-blocks')).body as { blocks: { batchId: string; state: string }[]; blockedBatches: Record<string, string[]> };
    // Lane 2 · P1: starting the recall published the tills' pack itself, so the block is already on it.
    expect(blocks.blocks).toEqual([expect.objectContaining({ productId: 'p-paneer', batchId: 'B-1', state: 'on_pack', atTheTill: 'plain_barcode_blocks_whole_product_2d_barcode_blocks_this_batch' })]);
    expect(blocks.blockedBatches).toEqual({ 'p-paneer': ['B-1'] });

    // A cold restart: the next pack is built from what the store kept.
    h = restart(h);
    const v2 = await lane();
    expect(held!.snapshot.products.find((p) => p.productId === 'p-paneer')).toMatchObject({ recallBlock: true, blockedBatches: ['B-1'] });
    expect(() => v2.scan(twoD('B-1'), today)).toThrow(RecalledItemError);
    expect(() => v2.scan(twoD('B-1'), today)).toThrow(/Paneer 200g" batch B-1/);
    expect(v2.scan(twoD('B-2'), today).batch).toMatchObject({ batchId: 'B-2', expiry: '2030-06-15' });
    expect(v2.scan(twoD('B-3'), today).markdownPriceMinor).toBe(4_500);
    // OB-139 "A": a plain barcode cannot say which batch it is, so it blocks the whole product.
    expect(() => v2.scan(PANEER, today)).toThrow(RecalledItemError);
    expect(v2.scan(CURD, today).product.productId).toBe('p-curd');
    expect(((await req('GET', '/v1/quality/sale-blocks')).body as { blocks: { state: string }[] }).blocks[0]!.state).toBe('on_pack');

    // The batch list rides under the signature: a pack edited to unblock B-1 does not verify, and the lane keeps v2.
    const tampered: SignedPack = { ...held!, snapshot: { ...held!.snapshot, version: held!.snapshot.version + 1, products: held!.snapshot.products.map((p) => (p.productId === 'p-paneer' ? { ...p, blockedBatches: ['B-9'] } : p)) } };
    expect(acceptPack({ incoming: tampered, held: held!, signer, tenantId: T })).toMatchObject({ accepted: false, rejectedBecause: 'signature_does_not_verify' });
    expect(canonicalise(held!.snapshot)).toContain('--batches');

    // Closed with evidence → the next pack lifts the B-1 block.
    await ok(req('POST', '/v1/quality/recalls/B-1/closure', { evidenceRef: 'DOC-recall-B-1' }), 'close');
    const v3 = await lane();
    expect(v3.scan(twoD('B-1'), today).batch?.batchId).toBe('B-1');
    expect(v3.scan(PANEER, today).product.productId).toBe('p-paneer');
  });

  it('a batch on quality hold is batch-precise too; a recall flag on the product itself blocks every batch', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    await req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 });
    const publish = (recallBlocked: boolean) => req('POST', '/v1/catalogue/products/p-paneer/publish', { product: { sku: 'SKU-PANEER', name: 'Paneer 200g', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft', recallBlocked }, categories: [GROCERY] });
    expect((await publish(false)).status).toBe(201);
    await req('POST', '/v1/prices/list/p-paneer/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 9_000, mrpMinor: 9_500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' });
    await req('POST', `/v1/catalogue/products/p-paneer/barcodes/${PANEER}`, { kind: 'ean' });
    expect((await req('POST', '/v1/quality/holds/B-7', { productId: 'p-paneer', reason: 'cold room breach' })).status).toBe(201);
    const pack = async (): Promise<CatalogueCache> => {
      await req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF });
      return new CatalogueCache(((await req('GET', '/v1/catalogue/pack')).body as SignedPack).snapshot);
    };
    const held = await pack();
    expect(() => held.scan(twoD('B-7'), { asOf: AS_OF })).toThrow(/batch B-7/);
    expect(held.scan(twoD('B-8'), { asOf: AS_OF }).batch?.batchId).toBe('B-8');
    // The product master's own recall flag is a block on the product: no batch list, so every batch is refused.
    expect((await publish(true)).status).toBe(201);
    const whole = await pack();
    expect(() => whole.scan(twoD('B-8'), { asOf: AS_OF })).toThrow(RecalledItemError);
  });
});
