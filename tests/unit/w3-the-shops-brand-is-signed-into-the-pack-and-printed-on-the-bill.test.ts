import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { brandedHeader } from '../../apps/pos/src/bill-receipt';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { canonicalise, acceptPack, type SignedPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { packBrandingOf } from '../../services/api/src/adapters';
import { tillCatalogue, screenBrand } from '../../edge/store-edge/src/screen-data';
import { apiHarness, TEST_PACK_KEY } from '../support/api-harness';
import { aStoreWithRules } from '../support/store-rules';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W3 · M36-FR-02 (OB-321 · "Offline: branding cached in the signed edge pack" · hard rule #1): the shop's own name, logo
 * and colours are signed into the catalogue pack, reach the till inside the catalogue it already holds, and are printed on
 * the bill with no network call at the sale.**
 *   • head office's pack carries the brand only once the shop set one — name, legal name, logo and colours only (OB-321),
 *     never another tenant's; a pack edited after signing to print another name fails to verify; a pack with no brand signs
 *     to exactly the bytes it always did (a box's held pack still verifies after the upgrade);
 *   • the store computer hands the brand to the till inside its catalogue, and to every screen as `sreBrand`;
 *   • the till's plain bill prints the name first (once, never twice); the real-trading tax invoice prints it above the
 *     legal name, untagged, so the Rule 46 fields are unchanged and the invoice still renders whole; no brand → the bill is
 *     exactly what it was. Synthetic data only.
 */

const NOW = new Date().toISOString();
const SIGNER = hmacSigner(TEST_PACK_KEY);
const BASE: CatalogueSnapshot = {
  tenantId: 't-brand', version: 2, builtAt: NOW,
  products: [{ productId: 'P-DAL', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active', hsnCode: '071360' }],
  barcodes: [{ code: '890000000001', productId: 'P-DAL', kind: 'standard' }],
};
const BRAND = { productName: 'Synthetic Fresh Mart', legalName: 'Synthetic Fresh Mart Pvt Ltd', colours: { primary: '#1a4d2e', onPrimary: '#ffffff' } };
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601'] };
const sign = (snapshot: CatalogueSnapshot): SignedPack => ({ snapshot, signature: SIGNER.sign(canonicalise(snapshot)) } as SignedPack);
const till = (catalogue: CatalogueSnapshot, extra: Record<string, unknown> = {}) => bootPos({
  laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: NOW.slice(0, 10), catalogue, taxPercent: 5, ...extra,
  durable: async () => ({ committed: true, durable: true, detail: 'd', laneMessage: 'ok' }),
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('the brand is signed into the pack', () => {
  it('signs under the pack\'s signature; a tampered name fails; a pack with none signs to the same bytes as before', () => {
    expect(canonicalise({ ...BASE })).toBe(canonicalise(BASE));
    expect(canonicalise({ ...BASE, branding: BRAND })).not.toBe(canonicalise(BASE));
    const signed = sign({ ...BASE, branding: BRAND });
    expect(acceptPack({ incoming: signed, signer: SIGNER, tenantId: 't-brand' }).accepted).toBe(true);
    const forged = { ...signed, snapshot: { ...signed.snapshot, branding: { ...BRAND, productName: 'Another Shop' } } };
    expect(acceptPack({ incoming: forged, signer: SIGNER, tenantId: 't-brand' })).toMatchObject({ accepted: false, rejectedBecause: 'signature_does_not_verify' });
    const stripped = { ...signed, snapshot: { ...BASE } };
    expect(acceptPack({ incoming: stripped, signer: SIGNER, tenantId: 't-brand' })).toMatchObject({ accepted: false, rejectedBecause: 'signature_does_not_verify' });
  });

  it('carries only the shop\'s own name, logo and colours — nothing set, or another tenant\'s, carries nothing', () => {
    expect(packBrandingOf(undefined, 't')).toBeUndefined();
    expect(packBrandingOf({ tenantId: 'other', productName: 'Not ours' }, 't')).toBeUndefined();
    expect(packBrandingOf({ tenantId: 't', productName: '  ' }, 't')).toBeUndefined();
    expect(packBrandingOf({ tenantId: 't', productName: ' Mart ', supportEmail: 'x@example.test', terminology: { branch: 'showroom' }, colours: { primary: '#000000', onPrimary: '#ffffff' } }, 't'))
      .toEqual({ productName: 'Mart', colours: { primary: '#000000', onPrimary: '#ffffff' } });
  });

  it('head office signs the shop\'s brand into the pack it publishes, only once one is set', async () => {
    const h = apiHarness();
    const T = randomUUID();
    const ok = async (method: 'POST' | 'PUT', path: string, body: unknown) => {
      const r = await h.request({ method, path, userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    };
    await h.seedOwner(T, 'u-owner');
    await aStoreWithRules(h, T, 'u-owner', 'S1', 0);
    await ok('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 });
    await ok('POST', '/v1/catalogue/products/p-rice/publish', { product: { sku: 'RICE-1', name: 'Ponni rice 1 kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] });
    await ok('POST', '/v1/prices/list/p-rice/entries/e1', { scope: 'store', scopeRef: 'S1', priceMinor: 6_200, mrpMinor: 7_000, costMinor: 4_800, marginFloorBps: 0, currency: 'INR', effectiveFrom: shopDateIn(NOW) });
    const pack = async () => (await h.request({ method: 'GET', path: '/v1/catalogue/pack', userId: 'u-owner', tenantId: T })).body as SignedPack;
    await ok('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: shopDateIn(NOW) });
    expect((await pack()).snapshot.branding).toBeUndefined();
    await ok('PUT', '/v1/platform/branding', BRAND);
    await ok('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: shopDateIn(NOW) });
    const branded = await pack();
    expect(branded.snapshot.branding).toEqual(BRAND);
    expect(acceptPack({ incoming: branded, signer: SIGNER, tenantId: T }).accepted).toBe(true);
  });
});

describe('the store computer hands it on, and the till prints it with no network', () => {
  it('the till\'s catalogue and every screen get the brand from the pack the box holds', () => {
    const pack = { known: false } as never;
    const signed = sign({ ...BASE, branding: BRAND });
    expect(tillCatalogue({ products: { known: false }, policies: { known: false } } as never, signed, NOW)?.branding).toEqual(BRAND);
    expect(screenBrand({ cataloguePack: signed } as never)).toEqual({ ...BRAND, packVersion: 2 });
    expect(screenBrand({ cataloguePack: sign(BASE), pack } as never)).toBeUndefined();
  });

  it('the plain bill prints the name first, once; the tax invoice above the legal name; no fetch is made', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('no network at the till'); });
    vi.stubGlobal('fetch', fetchSpy);
    expect(brandedHeader('Synthetic Fresh Mart', ['SYNTHETIC FRESH MART', 'GSTIN x'])).toEqual(['SYNTHETIC FRESH MART', 'GSTIN x']);
    expect(brandedHeader(undefined, ['A'])).toEqual(['A']);

    const plain = till({ ...BASE, branding: BRAND });
    plain.scanBarcode('890000000001');
    await plain.tenderCash('S-1', 'L1-0001', NOW);
    const r = plain.receiptLines();
    if (!r.ok) throw new Error(r.why);
    expect(r.lines.filter((l) => l.includes('Synthetic Fresh Mart'))).toHaveLength(1);
    expect(r.lines.findIndex((l) => l.includes('Synthetic Fresh Mart'))).toBeLessThan(r.lines.findIndex((l) => l.includes('Toor dal')));

    const rt = till({ ...BASE, branding: BRAND }, { realTrading: true, taxInvoice: SHOP });
    rt.scanBarcode('890000000001');
    await rt.tenderCash('S-2', 'L1-0002', NOW);
    const inv = rt.taxInvoice();
    if (!inv.ok) throw new Error(inv.why);
    const brandRow = inv.rows.findIndex((row) => row.text === 'Synthetic Fresh Mart');
    const legalRow = inv.rows.findIndex((row) => row.fields.includes('supplier_legal_name'));
    expect(brandRow).toBeGreaterThanOrEqual(0);
    expect(brandRow).toBeLessThan(legalRow);
    expect(inv.rows[brandRow]!.fields).toEqual([]);
    expect(inv.rows[legalRow]!.text).toBe(SHOP.legalName);

    // No brand in the pack → the bill is exactly what it always was.
    const none = till(BASE);
    none.scanBarcode('890000000001');
    await none.tenderCash('S-3', 'L1-0003', NOW);
    const n = none.receiptLines();
    if (!n.ok) throw new Error(n.why);
    expect(n.lines.join('\n')).not.toContain('Synthetic Fresh Mart');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
