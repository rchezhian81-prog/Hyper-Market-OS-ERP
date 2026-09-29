import { describe, it, expect } from 'vitest';
import { publishStepUpNeeded, DEFAULT_BULK_PUBLISH_THRESHOLD } from '../../services/catalogue/src/publish-step-up';
import { SETTINGS } from '../../packages/tenant/src/settings';
import type { CatalogueProduct, CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

// When does a catalogue publish need a fresh second-factor sign-in? (ADR-0013 point 4 · SEC-03 · Stage E
// slice 1.) The pure rule: BULK when the products added + changed + removed against the previous pack reach
// the owner's threshold; SENSITIVE when a regulated product is added or changed. A routine publish is not asked.

const product = (i: number, over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  productId: `P${i}`, sku: `SKU-${i}`, name: `Product ${i}`, baseUom: 'each',
  unitPriceMinor: 1_000 + i, taxBps: 500, mrpMinor: 5_000, status: 'active', ...over,
});
const snap = (products: CatalogueProduct[], version = 1): CatalogueSnapshot =>
  ({ tenantId: 't', version, builtAt: '2026-09-29T06:00:00Z', products, barcodes: [] });
const many = (n: number) => Array.from({ length: n }, (_, i) => product(i));

describe('publishStepUpNeeded — bulk', () => {
  it('a first publish counts every product as added: the first big load is bulk by definition', () => {
    const d = publishStepUpNeeded({ next: snap(many(DEFAULT_BULK_PUBLISH_THRESHOLD)) });
    expect(d.needed).toBe(true);
    expect(d.reasons).toEqual(['bulk']);
    expect(d.added).toBe(DEFAULT_BULK_PUBLISH_THRESHOLD);
    expect(d.because).toContain(`changes ${DEFAULT_BULK_PUBLISH_THRESHOLD} products`);
  });

  it('a first publish BELOW the threshold is routine', () => {
    const d = publishStepUpNeeded({ next: snap(many(DEFAULT_BULK_PUBLISH_THRESHOLD - 1)) });
    expect(d.needed).toBe(false);
    expect(d.because).toBeUndefined();
  });

  it('counts changed prices and removals, not products that are the same as before', () => {
    const before = snap(many(10), 1);
    const after = snap([
      ...many(8).map((p, i) => (i < 2 ? { ...p, unitPriceMinor: p.unitPriceMinor + 5 } : p)), // 2 changed, 2 removed (P8, P9)
      product(10), // 1 added
    ], 2);
    const d = publishStepUpNeeded({ previous: before, next: after, bulkThreshold: 5 });
    expect(d).toMatchObject({ added: 1, changed: 2, removed: 2, changedCount: 5, needed: true, reasons: ['bulk'] });
    expect(publishStepUpNeeded({ previous: before, next: after, bulkThreshold: 6 }).needed).toBe(false);
  });

  it('a re-ordered field list or a re-ordered product list is NOT a change', () => {
    const before = snap(many(3));
    const reordered = snap([...many(3)].reverse().map((p) => ({
      status: p.status, mrpMinor: p.mrpMinor, taxBps: p.taxBps, unitPriceMinor: p.unitPriceMinor,
      baseUom: p.baseUom, name: p.name, sku: p.sku, productId: p.productId,
    })), 2);
    expect(publishStepUpNeeded({ previous: before, next: reordered, bulkThreshold: 1 }).changedCount).toBe(0);
  });

  it('takes the threshold from the owner setting; a nonsense threshold falls back to the setting default', () => {
    expect(DEFAULT_BULK_PUBLISH_THRESHOLD).toBe(SETTINGS.CATALOGUE_BULK_PUBLISH_THRESHOLD.defaultValue);
    const d = publishStepUpNeeded({ next: snap(many(3)), bulkThreshold: 3 });
    expect(d.needed).toBe(true);
    expect(d.bulkThreshold).toBe(3);
    expect(publishStepUpNeeded({ next: snap(many(3)), bulkThreshold: 0 }).bulkThreshold).toBe(DEFAULT_BULK_PUBLISH_THRESHOLD);
    expect(publishStepUpNeeded({ next: snap(many(3)), bulkThreshold: 2.5 }).bulkThreshold).toBe(DEFAULT_BULK_PUBLISH_THRESHOLD);
  });
});

describe('publishStepUpNeeded — sensitive (regulated products)', () => {
  const regulated = (i: number, over: Partial<CatalogueProduct> = {}) => product(i, { regulatedFlags: { minimumAge: 18 }, ...over });

  it('adding a regulated product needs the step-up even when the publish is tiny', () => {
    const d = publishStepUpNeeded({ previous: snap(many(3)), next: snap([...many(3), regulated(9)], 2) });
    expect(d.needed).toBe(true);
    expect(d.reasons).toEqual(['sensitive']);
    expect(d.regulated).toEqual(['P9']);
    expect(d.because).toContain('1 regulated product (P9)');
  });

  it('changing a regulated product’s price needs it; a regulated product left untouched does not', () => {
    const before = snap([...many(3), regulated(9)]);
    const untouched = snap([...many(3).map((p, i) => (i === 0 ? { ...p, unitPriceMinor: 1 } : p)), regulated(9)], 2);
    expect(publishStepUpNeeded({ previous: before, next: untouched }).needed).toBe(false);
    const repriced = snap([...many(3), regulated(9, { unitPriceMinor: 99 })], 2);
    expect(publishStepUpNeeded({ previous: before, next: repriced }).reasons).toEqual(['sensitive']);
  });

  it('REMOVING the regulated flags from a product is sensitive too (its old form was regulated)', () => {
    const before = snap([regulated(1)]);
    const unflagged = snap([product(1)], 2);
    expect(publishStepUpNeeded({ previous: before, next: unflagged }).reasons).toEqual(['sensitive']);
  });

  it('an empty regulatedFlags object is not a regulation', () => {
    expect(publishStepUpNeeded({ previous: snap([]), next: snap([product(1, { regulatedFlags: {} })]) }).needed).toBe(false);
  });

  it('a publish can be both bulk and sensitive, and the refusal says both', () => {
    const d = publishStepUpNeeded({ next: snap([...many(4), regulated(9)]), bulkThreshold: 5 });
    expect(d.reasons).toEqual(['bulk', 'sensitive']);
    expect(d.because).toContain('bulk threshold of 5');
    expect(d.because).toContain('regulated product');
  });
});
