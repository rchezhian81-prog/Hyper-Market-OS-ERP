import { describe, it, expect } from 'vitest';
import { extractInclusiveGst, InvalidInclusiveTaxInput } from '../../packages/finance/src/inclusive-tax';

// Roadmap v2.1 A9 (GST extracted from tax-inclusive MRP) + A8 (place-of-supply split). The load-bearing
// invariant A9 states is: given an MRP + rate, taxable value + tax reconcile to the MRP TO THE PAISA.
// Because the tax is defined as the remainder (MRP − taxable), that holds by construction — proved here
// across every GST slab and a wide sweep of amounts, both intra-State (CGST+SGST) and inter-State (IGST).

const SLABS_BPS = [0, 500, 1200, 1800, 2800, 4000]; // 0 / 5 / 12 / 18 / 28 / 40 %

describe('extractInclusiveGst — A9: taxable + tax reconcile to the MRP to the paisa', () => {
  it('reconciles exactly for every slab across a wide sweep of MRPs, intra- and inter-State', () => {
    for (const rateBps of SLABS_BPS) {
      for (let mrpMinor = 1; mrpMinor <= 2_000; mrpMinor += 7) { // 1 paisa … ₹20, odd steps to hit odd paisa
        for (const placeOfSupply of ['intra_state', 'inter_state'] as const) {
          const r = extractInclusiveGst({ mrpMinor, rateBps, placeOfSupply });
          // The invariant: parts sum to the MRP, to the paisa.
          expect(r.taxableMinor + r.totalTaxMinor).toBe(mrpMinor);
          expect(r.grossMinor).toBe(mrpMinor);
          // Components always sum to the total tax — never a paisa created or dropped in the split.
          expect(r.components.reduce((s, c) => s + c.amountMinor, 0)).toBe(r.totalTaxMinor);
          // Nothing is ever charged above the MRP.
          expect(r.taxableMinor).toBeLessThanOrEqual(mrpMinor);
          expect(r.totalTaxMinor).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('extracts the textbook figures — ₹118 @ 18% → ₹100 + ₹18, ₹105 @ 5% → ₹100 + ₹5', () => {
    const a = extractInclusiveGst({ mrpMinor: 118_00, rateBps: 1800, placeOfSupply: 'inter_state' });
    expect(a.taxableMinor).toBe(100_00);
    expect(a.totalTaxMinor).toBe(18_00);

    const b = extractInclusiveGst({ mrpMinor: 105_00, rateBps: 500, placeOfSupply: 'inter_state' });
    expect(b.taxableMinor).toBe(100_00);
    expect(b.totalTaxMinor).toBe(5_00);
  });

  it('treats a nil rate as exempt — taxable equals the MRP and there are no tax lines', () => {
    const r = extractInclusiveGst({ mrpMinor: 4_999, rateBps: 0, placeOfSupply: 'intra_state' });
    expect(r.taxableMinor).toBe(4_999);
    expect(r.totalTaxMinor).toBe(0);
    expect(r.components).toEqual([]);
  });
});

describe('extractInclusiveGst — A8: place of supply decides the split, never the total', () => {
  it('intra-State splits into equal CGST + SGST at half the rate, summing to the whole tax', () => {
    const r = extractInclusiveGst({ mrpMinor: 118_00, rateBps: 1800, placeOfSupply: 'intra_state' });
    expect(r.components.map((c) => c.component)).toEqual(['CGST', 'SGST']);
    expect(r.components.every((c) => c.rateBps === 900)).toBe(true); // 9% + 9%
    const [cgst, sgst] = r.components;
    expect(cgst!.amountMinor).toBe(9_00);
    expect(sgst!.amountMinor).toBe(9_00);
    expect(cgst!.amountMinor + sgst!.amountMinor).toBe(r.totalTaxMinor);
  });

  it('inter-State is a single IGST at the full rate, equal to the intra-State total', () => {
    const intra = extractInclusiveGst({ mrpMinor: 250_00, rateBps: 1200, placeOfSupply: 'intra_state' });
    const inter = extractInclusiveGst({ mrpMinor: 250_00, rateBps: 1200, placeOfSupply: 'inter_state' });
    expect(inter.components).toHaveLength(1);
    expect(inter.components[0]!.component).toBe('IGST');
    expect(inter.components[0]!.rateBps).toBe(1200);
    // Same total tax whichever way it is split (A8: split, not total).
    expect(inter.totalTaxMinor).toBe(intra.totalTaxMinor);
    expect(inter.components[0]!.amountMinor).toBe(intra.components.reduce((s, c) => s + c.amountMinor, 0));
  });

  it('lands a single odd paisa deterministically on SGST, never duplicated or dropped', () => {
    // Find an MRP/rate whose extracted tax is odd, then assert the split.
    const r = extractInclusiveGst({ mrpMinor: 1_000, rateBps: 1800, placeOfSupply: 'intra_state' });
    // taxable 847, tax 153 (odd)
    expect(r.totalTaxMinor).toBe(153);
    const [cgst, sgst] = r.components;
    expect(cgst!.amountMinor).toBe(76);          // floor(153/2)
    expect(sgst!.amountMinor).toBe(77);          // remainder carries the odd paisa
    expect(cgst!.amountMinor + sgst!.amountMinor).toBe(153);
  });
});

describe('extractInclusiveGst — refuses nonsense rather than guessing', () => {
  it('rejects a non-positive or non-whole MRP', () => {
    expect(() => extractInclusiveGst({ mrpMinor: 0, rateBps: 1800, placeOfSupply: 'intra_state' })).toThrow(InvalidInclusiveTaxInput);
    expect(() => extractInclusiveGst({ mrpMinor: -100, rateBps: 1800, placeOfSupply: 'intra_state' })).toThrow(InvalidInclusiveTaxInput);
    expect(() => extractInclusiveGst({ mrpMinor: 10.5, rateBps: 1800, placeOfSupply: 'intra_state' })).toThrow(InvalidInclusiveTaxInput);
  });

  it('rejects a negative or non-whole rate', () => {
    expect(() => extractInclusiveGst({ mrpMinor: 10_000, rateBps: -1, placeOfSupply: 'inter_state' })).toThrow(InvalidInclusiveTaxInput);
    expect(() => extractInclusiveGst({ mrpMinor: 10_000, rateBps: 12.5, placeOfSupply: 'inter_state' })).toThrow(InvalidInclusiveTaxInput);
  });

  it('rejects an odd intra-State rate that cannot split into equal whole-bps halves', () => {
    expect(() => extractInclusiveGst({ mrpMinor: 10_000, rateBps: 501, placeOfSupply: 'intra_state' })).toThrow(InvalidInclusiveTaxInput);
    // …but the same odd rate is fine inter-State (a single IGST line).
    expect(() => extractInclusiveGst({ mrpMinor: 10_000, rateBps: 501, placeOfSupply: 'inter_state' })).not.toThrow();
  });
});
