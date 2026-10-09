import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { acceptPack, type SignedPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { CatalogueCache, RecalledItemError } from '../../packages/catalogue/src/catalogue';

// SF-08 (audit, HIGH): the recall register and the quality-hold register decided which BATCHES must not be sold, and
// nothing carried that to the till — the till's offline block came only from a flag ticked by hand on the product
// master. Owner decision 9 Oct 2026 "C (R3) and 1": the till blocks the WHOLE PRODUCT while any of its batches is
// recalled or held; blocking only the bad batch is release R3.
//
// The audit's own proof, end to end through the real API and the lane's own trust path:
//   recall initiated → head office's next SIGNED pack carries the product blocked → the lane accepts that pack and,
//   with no network at all, refuses the scan by name. And no silent gap (P-08): until the pack is published, head
//   office says the block has not reached any till; a recalled batch it cannot name to a product is said, not hidden.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORE = 'store-01';
const AS_OF = '2030-06-01';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const signer = hmacSigner(TEST_PACK_KEY);

const req = (h: ApiHarness, method: 'GET' | 'POST', path: string, key?: string, body?: unknown) =>
  h.request({ method, path, userId: 'u-owner', tenantId: A, ...(key === undefined ? {} : { idempotencyKey: key }), ...(body === undefined ? {} : { body }) });

async function product(h: ApiHarness, productId: string, sku: string, name: string, barcode: string): Promise<void> {
  expect((await req(h, 'POST', `/v1/catalogue/products/${productId}/publish`, `k-${productId}`, {
    product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft' }, categories: [GROCERY],
  })).status).toBeLessThan(300);
  expect((await req(h, 'POST', `/v1/prices/list/${productId}/entries/e1`, `k-price-${productId}`, {
    scope: 'store', scopeRef: STORE, priceMinor: 9000, mrpMinor: 9500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01',
  })).status).toBeLessThan(300);
  expect((await req(h, 'POST', `/v1/catalogue/products/${productId}/barcodes/${barcode}`, `k-bc-${productId}`, { kind: 'ean' })).status).toBeLessThan(300);
}

/** A batch head office received — the stock ledger is where a recall's batch is named to its product. */
const receive = async (h: ApiHarness, productId: string, batchId: string) =>
  expect((await req(h, 'POST', '/v1/inventory/movements', `mv-${batchId}-${productId}`, {
    movementId: `mv-${batchId}-${productId}`, productId, locationId: STORE, kind: 'received', quantityMinor: 20, uom: 'EA',
    occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', batchId,
  })).status).toBeLessThan(300);

async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  expect((await req(h, 'POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', 'k-tax', { rateBps: 500 })).status).toBeLessThan(300);
  await product(h, 'p-paneer', 'SKU-PANEER', 'Paneer 200g', '8901000000011');
  await product(h, 'p-curd', 'SKU-CURD', 'Curd 400g', '8901000000028');
  await receive(h, 'p-paneer', 'B-0412');
  await receive(h, 'p-paneer', 'B-0413');
  await receive(h, 'p-curd', 'C-0001');
  return h;
}

let published = 0;
const publish = async (h: ApiHarness): Promise<SignedPack> => {
  published += 1;
  expect((await req(h, 'POST', '/v1/catalogue/pack', `k-pub-${published}`, { storeId: STORE, asOf: AS_OF })).status).toBe(201);
  return (await req(h, 'GET', '/v1/catalogue/pack')).body as SignedPack;
};

/** The lane's own path: trust the pack only if its signature holds and it is newer, then scan with NO network. */
function laneTrading(incoming: SignedPack, held?: SignedPack): { cache: CatalogueCache; pack: SignedPack } {
  const accepted = acceptPack({ incoming, ...(held === undefined ? {} : { held }), signer, tenantId: A });
  expect(accepted.accepted).toBe(true);
  return { cache: new CatalogueCache(accepted.tradingOn!.snapshot), pack: accepted.tradingOn! };
}

interface Blocks {
  blocks: { productId: string | null; batchId: string; kind: string; state: string }[];
  blockedProducts: string[]; notYetOnPack: number; productUnknown: number; packVersion: number | null; detail: string;
}
const saleBlocks = async (h: ApiHarness) => (await req(h, 'GET', '/v1/quality/sale-blocks')).body as Blocks;

describe('SF-08: a recalled or held batch reaches the offline till on the next signed pack', () => {
  it('recall initiated → next signed pack → the lane refuses the product with no network; closed → sellable again', async () => {
    const h = await shop();
    const v1 = laneTrading(await publish(h));
    expect(v1.cache.scan('8901000000011').product.productId).toBe('p-paneer'); // sells before the recall

    // The recall is initiated on ONE batch of paneer.
    expect((await req(h, 'POST', '/v1/quality/recalls/B-0412', 'rc-1', { reason: 'supplier contamination notice' })).status).toBeLessThan(300);

    // Not yet published: head office says so — no till refuses it yet (P-08), and the lane still sells on v1.
    const before = await saleBlocks(h);
    expect(before.blocks).toEqual([expect.objectContaining({ productId: 'p-paneer', batchId: 'B-0412', kind: 'recall', state: 'not_yet_on_pack' })]);
    expect(before.notYetOnPack).toBe(1);
    expect(before.detail).toMatch(/publish/);

    // The next signed pack carries the block; the lane accepts it and refuses the scan by name — offline.
    const v2 = laneTrading(await publish(h), v1.pack);
    expect(() => v2.cache.scan('8901000000011')).toThrow(RecalledItemError);
    expect(() => v2.cache.scan('8901000000011')).toThrow(/Paneer 200g/);
    // Decision "C": the whole product, every batch, until R3. Curd is untouched.
    expect(v2.cache.scan('8901000000028').product.productId).toBe('p-curd');
    const after = await saleBlocks(h);
    expect(after.blocks[0]!.state).toBe('on_pack');
    expect(after.notYetOnPack).toBe(0);
    expect(after.packVersion).toBe(v2.pack.snapshot.version);

    // Closed with evidence → the next pack lets it sell again.
    expect((await req(h, 'POST', '/v1/quality/recalls/B-0412/closure', 'rc-close', { evidenceRef: 'DOC-recall-B-0412' })).status).toBeLessThan(300);
    expect((await saleBlocks(h)).blocks).toEqual([]);
    const v3 = laneTrading(await publish(h), v2.pack);
    expect(v3.cache.scan('8901000000011').product.productId).toBe('p-paneer');
  });

  it('a batch on quality hold blocks its product at the till until it is released', async () => {
    const h = await shop();
    const v1 = laneTrading(await publish(h));
    expect((await req(h, 'POST', '/v1/quality/holds/C-0001', 'qh-1', { productId: 'p-curd', reason: 'cold room 2 breach' })).status).toBe(201);
    expect((await saleBlocks(h)).blocks).toEqual([expect.objectContaining({ productId: 'p-curd', batchId: 'C-0001', kind: 'quality_hold', state: 'not_yet_on_pack' })]);

    const v2 = laneTrading(await publish(h), v1.pack);
    expect(() => v2.cache.scan('8901000000028')).toThrow(RecalledItemError);
    expect(v2.cache.scan('8901000000011').product.productId).toBe('p-paneer');

    await h.provisionRole(A, 'u-qc', 'store_manager');
    expect((await h.request({ method: 'POST', path: '/v1/quality/holds/C-0001/release', userId: 'u-qc', tenantId: A, idempotencyKey: 'rel-1', body: {} })).status).toBe(200);
    const v3 = laneTrading(await publish(h), v2.pack);
    expect(v3.cache.scan('8901000000028').product.productId).toBe('p-curd');
  });

  it('a product stays blocked while ANY of its blocks stands', async () => {
    const h = await shop();
    await req(h, 'POST', '/v1/quality/recalls/B-0412', 'rc-1', { reason: 'notice' });
    await req(h, 'POST', '/v1/quality/recalls/B-0413', 'rc-2', { reason: 'notice' });
    await req(h, 'POST', '/v1/quality/recalls/B-0412/closure', 'rc-c1', { evidenceRef: 'DOC-1' });
    expect((await saleBlocks(h)).blockedProducts).toEqual(['p-paneer']); // B-0413 still open
    const v1 = laneTrading(await publish(h));
    expect(() => v1.cache.scan('8901000000011')).toThrow(RecalledItemError);
  });

  it('a recalled batch head office cannot name to a product is said, not hidden', async () => {
    const h = await shop();
    await publish(h);
    await req(h, 'POST', '/v1/quality/recalls/X-UNKNOWN', 'rc-x', { reason: 'notice from FSSAI' });
    const b = await saleBlocks(h);
    expect(b.blocks).toEqual([expect.objectContaining({ productId: null, batchId: 'X-UNKNOWN', state: 'product_unknown' })]);
    expect(b.productUnknown).toBe(1);
    expect(b.blockedProducts).toEqual([]);
    expect(b.detail).toMatch(/cannot be named/);
  });

  it('only people who may read recalls see the list', async () => {
    const h = await shop();
    await h.provisionRole(A, 'u-till', 'cashier');
    expect((await h.request({ method: 'GET', path: '/v1/quality/sale-blocks', userId: 'u-till', tenantId: A })).status).toBe(403);
  });
});
