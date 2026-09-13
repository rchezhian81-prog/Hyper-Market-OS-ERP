import { describe, it, expect } from 'vitest';
import {
  assessProductDataQuality,
  BarcodeRegistry,
  type BarcodeAssignment,
  type ProductRecord,
  type DataQualityFinding,
} from '../../packages/product/src/index';

// A08 "Data Quality" (§7.1 / P-05 / M03-FR-02/04) — the deterministic scan behind the agent.
//
// It surfaces only what CAN go wrong in a live product master and matters — a sellable item with no
// barcode, two records that look like the same thing, an item with no printed MRP — and it NAMES the
// real product(s) as evidence. It never flags a missing tax class or a duplicate barcode, because the
// publish gate and the barcode register already make both impossible; a scan that always comes back
// empty reads as "all clear" when it was never possible. Nothing here merges or commits anything.

const TENANT = 'sre';

/** A fully-formed, publishable-quality product; overrides carve the gaps under test. */
const prod = (over: Partial<ProductRecord> & Pick<ProductRecord, 'productId' | 'sku' | 'name'>): ProductRecord => ({
  tenantId: TENANT,
  baseUom: 'each',
  primaryCategoryId: 'cat-1',
  taxClass: 'HSN-1001',
  lifecycle: 'active',
  mrpHistory: [{ value: { minor: 5000, currency: 'INR' }, effectiveFrom: '2026-01-01' }],
  ...over,
});

const bc = (code: string, productId: string): BarcodeAssignment => ({ code, productId, kind: 'ean' });
const kinds = (fs: readonly DataQualityFinding[]): string[] => fs.map((f) => f.kind);
const forProduct = (fs: readonly DataQualityFinding[], productId: string): DataQualityFinding[] =>
  fs.filter((f) => f.productIds.includes(productId));

describe('assessProductDataQuality — a grounded, evidence-backed review list', () => {
  it('flags a sellable product with no barcode, and cites the product itself', () => {
    const products = [prod({ productId: 'p1', sku: 'SKU-1', name: 'Tata Salt 1kg' })];
    const findings = assessProductDataQuality({ products, barcodes: new BarcodeRegistry() });

    const barcodeGap = forProduct(findings, 'p1').find((f) => f.kind === 'missing_barcode');
    expect(barcodeGap).toBeDefined();
    expect(barcodeGap!.confidence).toBe('certain');
    expect(barcodeGap!.headline).toContain('Tata Salt 1kg');
    // The evidence names the real product — an uncited finding is refused upstream.
    expect(barcodeGap!.evidence).toHaveLength(1);
    expect(barcodeGap!.evidence[0]).toMatchObject({ productId: 'p1', sku: 'SKU-1', name: 'Tata Salt 1kg' });
  });

  it('flags a sellable product with no printed MRP', () => {
    const products = [prod({ productId: 'p1', sku: 'SKU-1', name: 'Tata Salt 1kg', mrpHistory: [] })];
    const findings = assessProductDataQuality({
      products,
      barcodes: new BarcodeRegistry([bc('8901', 'p1')]),
    });
    const mrpGap = findings.find((f) => f.kind === 'missing_mrp');
    expect(mrpGap).toBeDefined();
    expect(mrpGap!.productIds).toEqual(['p1']);
    expect(mrpGap!.evidence[0]!.productId).toBe('p1');
  });

  it('surfaces two look-alike records as a suspected duplicate, citing BOTH, and never merges', () => {
    const products = [
      prod({ productId: 'p1', sku: 'SKU-1', name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad' }),
      prod({ productId: 'p2', sku: 'SKU-2', name: 'AASHIRVAAD ATTA 5 KG', brand: 'aashirvaad' }),
    ];
    const findings = assessProductDataQuality({
      products,
      barcodes: new BarcodeRegistry([bc('8901', 'p1'), bc('8902', 'p2')]),
    });
    const dup = findings.find((f) => f.kind === 'suspected_duplicate');
    expect(dup).toBeDefined();
    expect([...dup!.productIds].sort()).toEqual(['p1', 'p2']);
    expect(dup!.evidence.map((e) => e.productId).sort()).toEqual(['p1', 'p2']);
    expect(dup!.detail).toMatch(/merge/i); // it recommends the ordinary, approved path — it does not act
  });

  it('says nothing about a clean, well-formed catalogue', () => {
    const products = [
      prod({ productId: 'p1', sku: 'SKU-1', name: 'Tata Salt 1kg', brand: 'Tata' }),
      prod({ productId: 'p2', sku: 'SKU-2', name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad' }),
    ];
    const findings = assessProductDataQuality({
      products,
      barcodes: new BarcodeRegistry([bc('8901', 'p1'), bc('8902', 'p2')]),
    });
    expect(findings).toEqual([]);
  });

  it('ignores drafts and discontinued lines — a draft is expected to be incomplete, a dead line is not sold', () => {
    const products = [
      prod({ productId: 'd1', sku: 'SKU-D1', name: 'Draft Item', lifecycle: 'draft', mrpHistory: [] }),
      prod({ productId: 'x1', sku: 'SKU-X1', name: 'Old Item', lifecycle: 'discontinued', mrpHistory: [] }),
    ];
    // Both have no barcode AND no MRP, but neither is in scope.
    const findings = assessProductDataQuality({ products, barcodes: new BarcodeRegistry() });
    expect(findings).toEqual([]);
  });

  it('is deterministic — same master, same findings, same stable ids, in a stable order', () => {
    const products = [
      prod({ productId: 'p2', sku: 'SKU-2', name: 'AASHIRVAAD ATTA 5 KG', brand: 'aashirvaad', mrpHistory: [] }),
      prod({ productId: 'p1', sku: 'SKU-1', name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad' }),
    ];
    const barcodes = new BarcodeRegistry([bc('8901', 'p1')]); // p2 has no barcode
    const first = assessProductDataQuality({ products, barcodes });
    const second = assessProductDataQuality({ products, barcodes });
    expect(first).toEqual(second);

    // missing barcode (p2), then the duplicate pair, then missing MRP (p2) — each by product id.
    expect(kinds(first)).toEqual(['missing_barcode', 'suspected_duplicate', 'missing_mrp']);
    expect(first.map((f) => f.findingId)).toEqual([
      'dq-missing-barcode:p2',
      'dq-duplicate:p1:p2',
      'dq-missing-mrp:p2',
    ]);
  });

  it('gives every finding at least one piece of evidence — the invariant the agent depends on', () => {
    const products = [
      prod({ productId: 'p1', sku: 'SKU-1', name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad', mrpHistory: [] }),
      prod({ productId: 'p2', sku: 'SKU-2', name: 'AASHIRVAAD ATTA 5 KG', brand: 'aashirvaad', mrpHistory: [] }),
    ];
    const findings = assessProductDataQuality({ products, barcodes: new BarcodeRegistry() });
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(f.evidence.length).toBeGreaterThan(0);
  });
});
