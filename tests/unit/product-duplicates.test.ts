import { describe, it, expect } from 'vitest';
import {
  detectDuplicateProducts,
  mergeProducts,
  reverseMerge,
  resolveProductId,
  normaliseName,
  MergeApprovalRequiredError,
  SelfMergeError,
  type DuplicateCandidate,
  type MergeLink,
  type MergeRequest,
} from '../../packages/product/src/index';

// M03-FR-04 — duplicate products are how a catalogue rots. Detection produces a
// REVIEW LIST; nothing is ever auto-merged, and a merge is a reversible link rather
// than a deletion.

const AT = '2026-08-03T10:00:00Z';

const PRODUCTS: DuplicateCandidate[] = [
  { productId: 'p1', name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad', barcodes: ['8901', 'INT-1'], packSize: '5 kg' },
  { productId: 'p2', name: 'AASHIRVAAD ATTA 5 KG', brand: 'aashirvaad', barcodes: ['8902'], packSize: '5KG' },
  { productId: 'p3', name: 'Tata Salt 1kg', brand: 'Tata', barcodes: ['8903'], packSize: '1 kg' },
  { productId: 'p4', name: 'Rice Bag', barcodes: ['8901'] }, // shares p1's barcode
];

describe('detectDuplicateProducts — a review list, never a merge', () => {
  it('treats a shared barcode as near-certain, because one code means one item', () => {
    const pairs = detectDuplicateProducts(PRODUCTS);
    const barcodePair = pairs.find((p) => p.signal === 'shared_barcode');
    expect(barcodePair?.productIds).toEqual(['p1', 'p4']);
    expect(barcodePair?.confidence).toBe('near_certain');
    expect(barcodePair?.evidence).toContain('8901');
  });

  it('spots the same product entered twice with different capitals and spacing', () => {
    const pairs = detectDuplicateProducts(PRODUCTS);
    const pair = pairs.find((p) => p.productIds[0] === 'p1' && p.productIds[1] === 'p2');
    expect(pair?.signal).toBe('same_name_and_brand');
    expect(pair?.confidence).toBe('likely'); // same pack size too
    expect(pair?.evidence).toContain('pack size');
  });

  it('downgrades a same-name pair whose pack size differs — probably a variant', () => {
    const pairs = detectDuplicateProducts([
      { productId: 'a', name: 'Atta', brand: 'X', packSize: '5 kg' },
      { productId: 'b', name: 'Atta', brand: 'X', packSize: '10 kg' },
    ]);
    expect(pairs[0]?.confidence).toBe('possible');
    expect(pairs[0]?.evidence).toContain('different pack size');
  });

  it('leaves genuinely different products alone', () => {
    const pairs = detectDuplicateProducts(PRODUCTS);
    expect(pairs.some((p) => p.productIds.includes('p3'))).toBe(false);
  });

  it('takes the tenant’s own similarity threshold', () => {
    const near: DuplicateCandidate[] = [
      { productId: 'a', name: 'Sunflower Oil 1 Litre Pouch' },
      { productId: 'b', name: 'Sunflower Oil 1 Litre' },
    ];
    expect(detectDuplicateProducts(near, 10_000)).toHaveLength(1); // all shorter-name tokens shared
    expect(detectDuplicateProducts(near, 10_001)).toHaveLength(0);
  });

  it('normalises for comparison without touching the stored name', () => {
    expect(normaliseName('AASHIRVAAD  ATTA-5 KG')).toBe('aashirvaad atta 5 kg');
  });

  it('offers no way to merge automatically — the absence is the control', () => {
    const surface = detectDuplicateProducts as unknown as Record<string, unknown>;
    expect(surface['merge']).toBeUndefined();
    // Every pair is a proposal carrying its evidence, for a human to decide on.
    expect(detectDuplicateProducts(PRODUCTS).every((p) => p.evidence.length > 0)).toBe(true);
  });
});

describe('mergeProducts — approved, reversible, never destructive', () => {
  function request(over: Partial<MergeRequest> = {}): MergeRequest {
    return {
      mergeId: 'mrg-1',
      keepProductId: 'p1',
      supersedeProductId: 'p2',
      requestedBy: 'merch-1',
      reason: 'same item entered twice at go-live',
      ...over,
    };
  }

  it('merges only with a second person’s approval (§28)', () => {
    const link = mergeProducts(
      request(),
      { subjectRef: 'mrg-1', status: 'approved', decidedBy: 'manager-1' },
      AT,
    );
    expect(link.keepProductId).toBe('p1');
    expect(link.approvedBy).toBe('manager-1');
    expect(link.reversed).toBeUndefined();
  });

  it('refuses an unapproved merge, a self-approved one, and one with no reason', () => {
    expect(() => mergeProducts(request(), undefined, AT)).toThrow(MergeApprovalRequiredError);
    expect(() =>
      mergeProducts(request(), { subjectRef: 'mrg-1', status: 'pending', decidedBy: 'manager-1' }, AT),
    ).toThrow(/never automatic/);
    expect(() =>
      mergeProducts(request(), { subjectRef: 'mrg-1', status: 'approved', decidedBy: 'merch-1' }, AT),
    ).toThrow(/cannot approve it/);
    expect(() =>
      mergeProducts(request({ reason: '  ' }), { subjectRef: 'mrg-1', status: 'approved', decidedBy: 'manager-1' }, AT),
    ).toThrow(/no reason/);
  });

  it('refuses an approval that authorises a different merge, and a self-merge', () => {
    expect(() =>
      mergeProducts(request(), { subjectRef: 'mrg-OTHER', status: 'approved', decidedBy: 'manager-1' }, AT),
    ).toThrow(/different merge/);
    expect(() =>
      mergeProducts(
        request({ supersedeProductId: 'p1' }),
        { subjectRef: 'mrg-1', status: 'approved', decidedBy: 'manager-1' },
        AT,
      ),
    ).toThrow(SelfMergeError);
  });

  it('follows a merge to the surviving record — and stops following once reversed', () => {
    const link = mergeProducts(
      request(),
      { subjectRef: 'mrg-1', status: 'approved', decidedBy: 'manager-1' },
      AT,
    );
    expect(resolveProductId('p2', [link])).toBe('p1');
    expect(resolveProductId('p1', [link])).toBe('p1');
    expect(resolveProductId('p9', [link])).toBe('p9');

    // A wrong merge is recoverable: the superseded record was never deleted.
    const undone = reverseMerge(link);
    expect(undone.reversed).toBe(true);
    expect(undone.approvedBy).toBe('manager-1'); // the original decision is retained
    expect(resolveProductId('p2', [undone])).toBe('p2');
  });

  it('follows a chain of merges to the final survivor', () => {
    const links: MergeLink[] = [
      { mergeId: 'm1', keepProductId: 'p2', supersedeProductId: 'p3', requestedBy: 'a', approvedBy: 'b', reason: 'r', at: AT },
      { mergeId: 'm2', keepProductId: 'p1', supersedeProductId: 'p2', requestedBy: 'a', approvedBy: 'b', reason: 'r', at: AT },
    ];
    expect(resolveProductId('p3', links)).toBe('p1');
  });

  it('does not loop for ever if the links form a cycle', () => {
    const links: MergeLink[] = [
      { mergeId: 'm1', keepProductId: 'p2', supersedeProductId: 'p1', requestedBy: 'a', approvedBy: 'b', reason: 'r', at: AT },
      { mergeId: 'm2', keepProductId: 'p1', supersedeProductId: 'p2', requestedBy: 'a', approvedBy: 'b', reason: 'r', at: AT },
    ];
    expect(resolveProductId('p1', links)).toBe('p2');
  });
});
