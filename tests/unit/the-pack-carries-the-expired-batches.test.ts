import { describe, it, expect } from 'vitest';
import { expiredBatchesByProduct } from '../../services/inventory/src/sale-blocks';
import { republishWithExpired } from '../../services/catalogue/src/recall-republish';
import { publishPack, canonicalise, hmacSigner, type SignedPack } from '../../services/catalogue/src/index';
import { CatalogueCache, ExpiredItemError, type CatalogueSnapshot, type CatalogueProduct } from '../../packages/catalogue/src/catalogue';

// M10-FR-01 · B8 (integration follow-up): the expired-batch state into the till's pack. Pure engines.

const signer = hmacSigner('unit-expired-batches-key'.padEnd(48, '0'));
const product = (over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({ productId: 'p-curd', sku: 'SKU-CURD', name: 'Curd 400g', baseUom: 'ea', unitPriceMinor: 6_000, taxBps: 500, status: 'active', ...over });
const snapshot = (products: readonly CatalogueProduct[], version = 1): CatalogueSnapshot => ({
  tenantId: 't', version, builtAt: '2026-10-23T00:00:00.000Z', scope: { tenantId: 't', storeId: 's' },
  products, barcodes: [{ code: '8901000000026', productId: 'p-curd', kind: 'standard' }],
});
const signed = (products: readonly CatalogueProduct[]): SignedPack => {
  const r = publishPack({ snapshot: snapshot(products), approvals: [], signer, publishedBy: 'u', publishedAt: '2026-10-23T00:00:00.000Z' });
  if (!r.ok || r.pack === undefined) throw new Error(r.detail);
  return r.pack;
};

describe('the expired batches, by product', () => {
  it('each batch once with its own date, sorted; a batch with no id cannot be named on a barcode and is left out', () => {
    const facts = [
      { productId: 'p-curd', locationId: 'S1', batchId: 'B-2', expiry: '2026-10-20', movedAt: 'x' },
      { productId: 'p-curd', locationId: 'S2', batchId: 'B-2', expiry: '2026-10-20', movedAt: 'x' },
      { productId: 'p-curd', locationId: 'S1', batchId: 'B-1', expiry: '2026-10-19', movedAt: 'x' },
      { productId: 'p-milk', locationId: 'S1', batchId: null, expiry: '2026-10-19', movedAt: 'x' },
    ];
    expect([...expiredBatchesByProduct(facts)]).toEqual([['p-curd', [{ batchId: 'B-1', expiry: '2026-10-19' }, { batchId: 'B-2', expiry: '2026-10-20' }]]]);
  });
});

describe('the lane refuses an expired batch on its batch barcode, offline', () => {
  it('a 2D code naming it is refused whatever the lane\'s clock; a sibling batch and a plain barcode sell', () => {
    const cache = new CatalogueCache(snapshot([product({ expiredBatches: [{ batchId: 'B-OLD', expiry: '2026-10-21' }] })]));
    expect(() => cache.scan('(01)08901000000026(10)B-OLD')).toThrow(ExpiredItemError);
    expect(() => cache.scan('(01)08901000000026(10)B-OLD', { asOf: '2020-01-01' })).toThrow(/2026-10-21/);
    expect(cache.scan('(01)08901000000026(10)B-NEW').batch).toMatchObject({ batchId: 'B-NEW' });
    expect(cache.scan('8901000000026').product.productId).toBe('p-curd');
  });
});

describe('the expired-batch pack', () => {
  it('re-signs the pack the tills hold one version on, adding only, prices untouched; nothing new is nothing published', () => {
    const previous = signed([product()]);
    const r = republishWithExpired({ previous, expired: new Map([['p-curd', [{ batchId: 'B-OLD', expiry: '2026-10-21' }]], ['p-gone', [{ batchId: 'X', expiry: '2026-10-01' }]]]), signer, publishedBy: 'expiry-sweep', publishedAt: '2026-10-23T01:00:00.000Z' });
    expect(r.outcome).toBe('published');
    if (r.outcome !== 'published') return;
    expect(r.pack.snapshot.version).toBe(2);
    expect(r.pack.snapshot.products).toEqual([{ ...product(), expiredBatches: [{ batchId: 'B-OLD', expiry: '2026-10-21' }] }]);
    expect(r.newlyBlocked).toEqual(['p-curd']);
    expect(canonicalise(r.pack.snapshot)).toContain('--expired');
    expect(canonicalise(previous.snapshot)).not.toContain('--expired'); // a pack without them signs exactly as before
    expect(republishWithExpired({ previous: r.pack, expired: new Map([['p-curd', [{ batchId: 'B-OLD', expiry: '2026-10-21' }]]]), signer, publishedBy: 'x', publishedAt: 'y' }).outcome).toBe('already_on_pack');
  });
});
