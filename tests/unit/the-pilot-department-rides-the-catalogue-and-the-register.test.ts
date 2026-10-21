import { describe, it, expect } from 'vitest';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { buildCatalogueSnapshot } from '../../packages/catalogue/src/snapshot-builder';
import { canonicalise, publishPack, acceptPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { toMaster } from '../../services/catalogue/src/catalogue-preview';
import { tillCatalogue } from '../../edge/store-edge/src/screen-data';
import { emptyPack, withMigrationFeed, type StorePack } from '../../edge/store-edge/src/store-pack';
import { readMigrationFeed } from '../../edge/sync-agent/src/migration-feed';
import { checkRefundOf, checkSaleOf } from '../../edge/store-edge/src/evening-check-box';

/**
 * OB-263 · MG-05 — the evening check keeps only the PILOT DEPARTMENT's items, and the department comes from the store's own
 * catalogue: each product's department (the product master's primary category — what the department slice loads) rides
 * the signed catalogue pack to the store computer, UNDER the signature; and which department is the pilot's comes from
 * head office's register — the newest applied department slice. A pack without departments signs exactly as before; a
 * feed whose department is not readable is not taken. The till's own sale and refund records are read for the check as
 * written (a refund carries no trading day — it is dated by the shop's own day rule). Synthetic data only.
 */

const signer = hmacSigner(['dept', 'pack', 'key'].join('-').padEnd(40, '0'));
const NOW = '2026-10-21T06:00:00.000Z';
const snapshot = (categoryId?: string): CatalogueSnapshot => ({
  tenantId: 't', version: 1, builtAt: NOW,
  products: [{ productId: 'P1', sku: 'S1', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active', ...(categoryId === undefined ? {} : { categoryId }) }],
  barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
});

describe('the department rides the signed catalogue pack', () => {
  it('the product master\'s category becomes the pack product\'s department', () => {
    const master = toMaster({ productId: 'P1', sku: 'S1', name: 'Toor dal', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' } as never, NOW);
    expect(master.categoryId).toBe('grocery');
    expect(toMaster({ productId: 'P2', sku: 'S2', name: 'x', baseUom: 'ea', primaryCategoryId: null, taxClass: '1006', lifecycle: 'active' } as never, NOW).categoryId).toBeUndefined();
    const built = buildCatalogueSnapshot({
      scope: { tenantId: 't', storeId: 'store-1' }, version: 1, asOf: NOW, products: [master],
      taxClasses: { 1006: 500 }, barcodes: [],
      priceEntries: [{ id: 'PE-1', productId: 'P1', scope: 'store', scopeRef: 'store-1', price: { minor: 10_500, currency: 'INR' }, effectiveFrom: '2026-01-01T00:00:00.000Z', status: 'active', version: 1 }] as never,
    } as never);
    expect(built.snapshot.products[0]).toMatchObject({ productId: 'P1', categoryId: 'grocery' });
  });

  it('under the signature: a department changed after signing fails to verify; a pack without departments signs as before', () => {
    const published = publishPack({ snapshot: snapshot('grocery'), approvals: [], signer, publishedBy: 'u-owner', publishedAt: NOW });
    expect(published.ok).toBe(true);
    const pack = published.pack!;
    expect(acceptPack({ incoming: pack, signer, tenantId: 't' }).accepted).toBe(true);
    const moved = { ...pack, snapshot: { ...pack.snapshot, products: pack.snapshot.products.map((p) => ({ ...p, categoryId: 'personal_care' })) } };
    expect(acceptPack({ incoming: moved, signer, tenantId: 't' })).toMatchObject({ accepted: false, rejectedBecause: 'signature_does_not_verify' });
    const { categoryId: _c, ...plain } = pack.snapshot.products[0]!;
    void _c;
    expect(acceptPack({ incoming: { ...pack, snapshot: { ...pack.snapshot, products: [plain] } }, signer, tenantId: 't' }).accepted).toBe(false);
    expect(canonicalise(snapshot())).not.toContain('--categories');
    expect(canonicalise(snapshot('grocery'))).toContain('--categories');
    expect(canonicalise(snapshot('grocery')).startsWith(canonicalise(snapshot()))).toBe(true);
  });

  it('the store computer\'s catalogue carries each product\'s department, from the pulled pack or the pack file', () => {
    const fromFile: StorePack = { ...emptyPack(), products: { known: true, value: [{ productId: 'P9', name: 'Sugar', categoryId: 'grocery', unitPriceMinor: 4500, uom: 'ea', barcodes: [], availableMinor: 1 }] } } as StorePack;
    expect(tillCatalogue(fromFile, undefined, NOW)?.products[0]).toMatchObject({ productId: 'P9', categoryId: 'grocery' });
    const published = publishPack({ snapshot: snapshot('grocery'), approvals: [], signer, publishedBy: 'u-owner', publishedAt: NOW }).pack!;
    expect(tillCatalogue(fromFile, published, NOW)?.products[0]).toMatchObject({ productId: 'P1', categoryId: 'grocery' });
  });
});

describe('which department is the pilot\'s: head office\'s register, laid into the store computer\'s terms', () => {
  const feed = (extra: Record<string, unknown>) => readMigrationFeed({ tenantId: 't', generatedAt: NOW, policy: { cutoverId: 'CUT-1', requiredCleanDays: 2, dailyReconcilerUserId: 'u-owner' }, refusedDecisions: [], rollbacks: [], ...extra });

  it('the applied slice\'s department is taken; a garbled one refuses the feed; absent keeps what the box holds', () => {
    const f = feed({ pilotDepartment: { categoryId: 'grocery', name: 'Grocery', loadId: 'load-1' } })!;
    const pack = withMigrationFeed(emptyPack(), f, NOW);
    expect(pack.migrationPolicy).toMatchObject({ known: true, value: { cutoverId: 'CUT-1', dailyReconcilerUserId: 'u-owner', pilotDepartment: { categoryId: 'grocery', name: 'Grocery', loadId: 'load-1' } } });
    expect(feed({ pilotDepartment: { categoryId: '', name: 'x' } })).toBeUndefined();
    expect(feed({ pilotDepartment: 'grocery' })).toBeUndefined();
    const kept = withMigrationFeed(pack, feed({})!, NOW);
    expect(kept.migrationPolicy).toMatchObject({ value: { pilotDepartment: { categoryId: 'grocery' } } });
  });
});

describe('the till\'s own records, as the evening check reads them', () => {
  it('a sale keeps its lines and its old bill number; a refund is dated by the shop\'s own day rule', () => {
    expect(checkSaleOf({ id: 'S-1', receiptNumber: 'B1', tradingDay: '2026-10-21', oldErpBillNumber: 'OLD/1', lines: [{ productId: 'P1', quantityMinor: 2, uom: 'ea', lineTotalMinor: 21_000, taxRateBps: 500 }, { productId: 7 }] }))
      .toEqual({ saleId: 'S-1', number: 'B1', tradingDay: '2026-10-21', oldErpBillNumber: 'OLD/1', lines: [{ productId: 'P1', quantityMinor: 2, uom: 'ea', lineTotalMinor: 21_000, taxRateBps: 500 }] });
    expect(checkSaleOf({ id: 'S-2', tradingDay: '2026-10-21', oldErpBillNumber: '9876543210', lines: [] })).not.toHaveProperty('oldErpBillNumber');
    const dayOf = (iso: string): string => (iso < '2026-10-21T20:30:00.000Z' ? '2026-10-21' : '2026-10-22');
    expect(checkRefundOf({ returnId: 'RT-1', originalSaleId: 'S-1', refundMinor: 10_500, processedAt: '2026-10-21T10:00:00.000Z', lines: [{ productId: 'P1', quantityMinor: 1 }] }, dayOf))
      .toEqual({ returnId: 'RT-1', originalSaleId: 'S-1', tradingDay: '2026-10-21', refundMinor: 10_500, lines: [{ productId: 'P1', quantityMinor: 1 }] });
    expect(checkRefundOf({ returnId: 'RT-2', refundMinor: 1, processedAt: '2026-10-21T21:00:00.000Z', lines: [] }, dayOf)?.tradingDay).toBe('2026-10-22');
    expect(checkRefundOf({ returnId: 'RT-3', refundMinor: 1, lines: [] }, dayOf)).toBeUndefined();
  });
});
