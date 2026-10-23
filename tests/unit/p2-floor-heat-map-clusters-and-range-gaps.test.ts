import { describe, it, expect } from 'vitest';
import {
  readFloorPlan, floorHeatMap, clusterStores, seasonEndDecisions, seasonEnded, priceBands, rangeGaps, privateLabelMargins,
  type FloorArea, type SeasonPlan,
} from '../../packages/merchandising/src/index';

// OB-288 P2 — pure: the floor plan (OB-308: coordinates per area) and its heat map (sales or margin per sq ft, never a
// margin costed at zero); clusters are the price-zone register (OB-318) and a season ends into clearance or a clean delist;
// the range-gap report (OB-319) files the shop's own lost-demand facts by category and price band, with no band invented.

const known = new Set(['A1', 'A2', 'B1', 'C1']);
const area = (over: Partial<FloorArea> & { areaId: string }): Record<string, unknown> => ({ name: over.areaId, x: 0, y: 0, width: 10, depth: 10, locationIds: [], ...over });

describe('the floor plan', () => {
  it('reads a plan whose areas sit on the floor, do not overlap and hold known shelf places once', () => {
    const r = readFloorPlan({ widthFt: 100, depthFt: 80, areas: [area({ areaId: 'staples', locationIds: ['A1', 'A2'], squareFeet: 80 }), area({ areaId: 'dairy', x: 10, nameTa: 'பால் பொருட்கள்', locationIds: ['B1'] })] }, known);
    expect(r.problems).toEqual([]);
    expect(r.plan!.areas.map((a) => [a.areaId, a.squareFeet])).toEqual([['staples', 80], ['dairy', 100]]);
  });

  it('refuses each fault by name', () => {
    const p = (areas: unknown[], locations: ReadonlySet<string> | undefined = known) => readFloorPlan({ widthFt: 50, depthFt: 50, areas }, locations).problems;
    expect(p([area({ areaId: 'a', x: 45 })])[0]).toMatch(/runs off the floor/);
    expect(p([area({ areaId: 'a' }), area({ areaId: 'b', x: 5 })])).toEqual(['a and b overlap on the floor']);
    expect(p([area({ areaId: 'a', locationIds: ['A1'] }), area({ areaId: 'b', x: 20, locationIds: ['A1'] })])[0]).toMatch(/already in a/);
    expect(p([area({ areaId: 'a', locationIds: ['Z9'] })])[0]).toMatch(/not on the store's shelf map/);
    expect(readFloorPlan({ widthFt: 50, depthFt: 50, areas: [area({ areaId: 'a', locationIds: ['A1'] })] }, undefined).problems[0]).toMatch(/no published shelf map/);
    expect(p([area({ areaId: 'a', squareFeet: 101 })])[0]).toMatch(/no more than its footprint/);
    expect(p([area({ areaId: 'a' }), area({ areaId: 'a', x: 20 })])[0]).toMatch(/used twice/);
    expect(readFloorPlan({ widthFt: 0, depthFt: 10, areas: [] }, known).problems[0]).toMatch(/width and depth/);
  });
});

describe('the heat map', () => {
  const plan = { areas: [
    { areaId: 'staples', name: 'Staples', x: 0, y: 0, width: 10, depth: 10, squareFeet: 100, locationIds: ['A1'] },
    { areaId: 'dairy', name: 'Dairy', nameTa: 'பால்', x: 10, y: 0, width: 5, depth: 10, squareFeet: 50, locationIds: ['B1'] },
    { areaId: 'empty', name: 'Empty', x: 0, y: 20, width: 5, depth: 5, squareFeet: 25, locationIds: ['C1'] },
  ] as const };
  const primary = new Map([['rice', 'A1'], ['dal', 'A1'], ['milk', 'B1'], ['ghee', 'C1']]);
  const takings = [
    { productId: 'rice', salesMinor: 100_000, netSalesMinor: 95_000, costMinor: 80_000 },
    { productId: 'dal', salesMinor: 50_000, netSalesMinor: 47_500, costMinor: 40_000 },
    { productId: 'milk', salesMinor: 60_000, netSalesMinor: 57_000, costMinor: undefined },
    { productId: 'soap', salesMinor: 9_000, netSalesMinor: 7_600, costMinor: 5_000 },
  ];

  it('colours each area by sales per sq ft against the best area', () => {
    const h = floorHeatMap({ plan, primaryLocationOf: primary, takings, measure: 'sales', currency: 'INR' });
    const by = new Map(h.areas.map((a) => [a.areaId, a]));
    expect(by.get('staples')!.salesPerSqFt).toEqual({ kind: 'per_sq_ft', minorPerSqFt: 1_500 });
    expect(by.get('dairy')!.salesPerSqFt).toEqual({ kind: 'per_sq_ft', minorPerSqFt: 1_200 });
    expect(by.get('staples')!.heat).toBe(100);
    expect(by.get('dairy')!.heat).toBe(80);
    expect(by.get('empty')!).toMatchObject({ heat: 0, salesMinor: 0, products: ['ghee'] });
    expect(h.notOnFloorPlan).toEqual({ products: ['soap'], salesMinor: 9_000 });
  });

  it('by margin, an area holding a product with no known cost is NOT KNOWN — named, never costed at zero', () => {
    const h = floorHeatMap({ plan, primaryLocationOf: primary, takings, measure: 'margin', currency: 'INR' });
    const dairy = h.areas.find((a) => a.areaId === 'dairy')!;
    expect(dairy).toMatchObject({ marginMinor: null, marginNotKnownFor: ['milk'], heat: null });
    expect(dairy.marginPerSqFt.kind).toBe('not_meaningful');
    expect(h.areas.find((a) => a.areaId === 'staples')).toMatchObject({ marginMinor: 22_500, heat: 100 });
  });
});

describe('clusters are the price-zone register, and a season ends by the drop rule', () => {
  it('a store\'s latest zone decides its cluster', () => {
    const m = [
      { storeId: 'S1', zoneId: 'north', setAt: '2026-10-01T00:00:00Z' }, { storeId: 'S2', zoneId: 'north', setAt: '2026-10-01T00:00:00Z' },
      { storeId: 'S2', zoneId: 'south', setAt: '2026-10-05T00:00:00Z' }, { storeId: 'S3', zoneId: 'north', setAt: '2026-10-06T00:00:00Z' },
    ];
    expect(clusterStores(m, 'north')).toEqual(['S1', 'S3']);
    expect(clusterStores(m, 'south')).toEqual(['S2']);
  });

  it('stock still on the shelf goes to clearance; none is delisted; effective the day after the season', () => {
    const plan: SeasonPlan = { planId: 'diwali', zoneId: 'north', storeIds: ['S1', 'S3'], productIds: ['crackers', 'sweets-box'], listFrom: '2026-10-15', listTo: '2026-11-10', reason: 'Diwali', setBy: 'u-owner', setAt: '2026-10-01T00:00:00Z' };
    expect(seasonEnded(plan, '2026-11-10')).toBe(false);
    expect(seasonEnded(plan, '2026-11-11')).toBe(true);
    const d = seasonEndDecisions({ plan, onHand: (s, p) => (s === 'S1' && p === 'crackers' ? 12 : 0), decidedBy: 'season-sweep' });
    expect(d.map((x) => [x.storeId, x.productId, x.outcome])).toEqual([
      ['S1', 'crackers', 'clearance'], ['S1', 'sweets-box', 'delisted'], ['S3', 'crackers', 'delisted'], ['S3', 'sweets-box', 'delisted'],
    ]);
    expect(d[0]!.entry).toMatchObject({ reason: 'seasonal_end', effectiveFrom: '2026-11-11', decidedBy: 'season-sweep' });
  });
});

describe('range gaps and private label', () => {
  it('no band edges is one band, said — never an invented band', () => {
    expect(priceBands([])).toEqual([{ fromMinor: 0, toMinor: null, label: 'all prices' }]);
    expect(priceBands([20_000, 5_000]).map((b) => b.label)).toEqual(['under ₹50', '₹50 to ₹200', '₹200 and above']);
  });

  it('files short-picks and failed substitutions by category and band, the worst first', () => {
    const rows = rangeGaps({
      facts: [
        { kind: 'short_pick', productId: 'oil-1l', quantityMinor: 2, unitPriceMinor: 18_000 },
        { kind: 'short_pick', productId: 'oil-5l', quantityMinor: 1, unitPriceMinor: 80_000 },
        { kind: 'failed_substitution', productId: 'oil-1l', quantityMinor: 1, unitPriceMinor: 18_000 },
        { kind: 'short_pick', productId: 'salt', quantityMinor: 1, unitPriceMinor: undefined },
      ],
      categoryOf: (p) => (p.startsWith('oil') ? 'oils' : 'staples'),
      bands: priceBands([5_000, 20_000]),
    });
    expect(rows[0]).toEqual({ categoryId: 'oils', band: '₹50 to ₹200', shortPicks: 1, shortPickedQuantityMinor: 2, failedSubstitutions: 1, products: ['oil-1l'] });
    expect(rows.map((r) => r.band)).toContain('price not known');
  });

  it('private-label margin against branded, per category; an unknown cost is named, not zero', () => {
    const rows = privateLabelMargins({
      sold: [
        { productId: 'sre-rice', netSalesMinor: 100_000, costMinor: 70_000 },
        { productId: 'brand-rice', netSalesMinor: 200_000, costMinor: 170_000 },
        { productId: 'sre-dal', netSalesMinor: 50_000, costMinor: undefined },
      ],
      categoryOf: () => 'staples',
      isPrivateLabel: (p) => p.startsWith('sre-'),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branded).toMatchObject({ marginMinor: 30_000, marginBps: 1_500 });
    expect(rows[0]!.privateLabel).toMatchObject({ marginMinor: null, marginBps: null, costNotKnownFor: ['sre-dal'], netSalesMinor: 150_000 });
  });
});
