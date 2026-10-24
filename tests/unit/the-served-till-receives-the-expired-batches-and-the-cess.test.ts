import { describe, it, expect } from 'vitest';
import { emptyPack } from '../../edge/store-edge/src/store-pack';
import { posPayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/index';
import { hmacSigner } from '../../services/catalogue/src/index';
import { publishPack, type SignedPack } from '../../services/catalogue/src/pack';
import { CatalogueCache, ExpiredItemError, type CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **The SERVED till's catalogue carries what the signed pack carries for it** — the expired batches (M10-FR-01 · M13-FR-02)
 * and the compensation cess (A7). The box builds the till page's catalogue (`posPayload`) field by field from its signed
 * pack; before this, `expiredBatches` and `cess` were dropped there, so a till booted from the page (the real lane) sold
 * an expired batch's 2D code, took a return of it back to the shelf, and charged no cess — even though tests that booted
 * the till on the raw pack passed. Synthetic data only.
 */

const KEY = ['served', 'till', 'pack', 'fields', 'key'].join('-').padEnd(48, '0');
const AT = '2026-10-23T08:00:00.000Z';
const CURD = '8901000000026';

const signed = (): SignedPack => {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version: 9, builtAt: AT,
    products: [
      { productId: 'p-curd', sku: 'CURD', name: 'Curd 400g', baseUom: 'ea', unitPriceMinor: 6_000, taxBps: 500, status: 'active', expiredBatches: [{ batchId: 'B-OLD', expiry: '2026-10-20' }] },
      { productId: 'p-gutkha', sku: 'PAN', name: 'Pan masala 10g', baseUom: 'ea', unitPriceMinor: 1_000, taxBps: 2_800, hsnCode: '21069020', status: 'active', cess: { advaloremBps: 6_000, specificPerQuantityMinor: 0, perQuantity: 1 } },
      { productId: 'p-dal', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active' },
    ],
    barcodes: [{ code: CURD, productId: 'p-curd', kind: 'standard' }, { code: '8901000000033', productId: 'p-gutkha', kind: 'standard' }, { code: '8901000000040', productId: 'p-dal', kind: 'standard' }],
  };
  const r = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-hq', publishedAt: AT });
  if (!r.ok || r.pack === undefined) throw new Error(r.detail);
  return r.pack;
};

const input = (cataloguePack: SignedPack): ScreenInput => ({
  pack: emptyPack(), sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: AT, tradingDay: '2026-10-23', cataloguePack,
});

describe('the served till catalogue carries the expired batches and the cess from the signed pack', () => {
  const served = posPayload(input(signed())) as unknown as CatalogueSnapshot;
  const of = (id: string) => served.products.find((p) => p.productId === id);

  it('the expired batches and the cess ride as signed; a product with neither carries neither', () => {
    expect(of('p-curd')?.expiredBatches).toEqual([{ batchId: 'B-OLD', expiry: '2026-10-20' }]);
    expect(of('p-gutkha')?.cess).toEqual({ advaloremBps: 6_000, specificPerQuantityMinor: 0, perQuantity: 1 });
    expect(of('p-dal')).not.toHaveProperty('expiredBatches');
    expect(of('p-dal')).not.toHaveProperty('cess');
  });

  it('a till built from the served page refuses the expired batch\'s 2D code offline; its sibling batch and the plain barcode sell', () => {
    const lane = new CatalogueCache(served);
    expect(() => lane.scan(`(01)0${CURD}(10)B-OLD`)).toThrow(ExpiredItemError);
    expect(lane.scan(`(01)0${CURD}(10)B-NEW`).product.productId).toBe('p-curd');
    expect(lane.scan(CURD).product.productId).toBe('p-curd');
  });
});
