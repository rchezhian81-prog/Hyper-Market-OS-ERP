import { describe, it, expect } from 'vitest';
import {
  spacePerformance,
  reviewDisplayContracts,
  type DisplayContract,
  type SpaceArea,
} from '../../packages/merchandising/src/index';
import { money } from '../../packages/contracts/src/money';

// M04-FR-04 / D02-FR-06 — a 14,000 sq ft shop has a fixed floor. Every square foot
// given to one category is taken from another, and the only honest comparison is
// MARGIN per square foot, not turnover.

const INR = 'INR' as const;
const TODAY = '2026-08-04';

const AREAS: SpaceArea[] = [
  { areaId: 'grocery', storeId: 'store-1', name: 'Grocery', squareFeet: 4_000 },
  { areaId: 'fresh', storeId: 'store-1', name: 'Fresh', squareFeet: 2_000 },
  { areaId: 'household', storeId: 'store-1', name: 'Household', squareFeet: 4_000 },
];

describe('spacePerformance — turnover flatters, margin decides', () => {
  const result = spacePerformance({
    areas: AREAS,
    sales: {
      grocery: money(40_000_00, INR),
      fresh: money(20_000_00, INR),
      household: money(12_000_00, INR),
    },
    grossMargin: {
      grocery: money(2_000_00, INR), // 5% — big turnover, thin margin
      fresh: money(5_000_00, INR), // 25% — half the space, most of the money
      household: money(1_000_00, INR),
    },
    currency: INR,
  });

  it('ranks by margin per square foot, not by sales', () => {
    // Grocery sells twice what Fresh does and is still the worse use of floor.
    expect(result.map((r) => r.areaId)).toEqual(['fresh', 'grocery', 'household']);
    const fresh = result.find((r) => r.areaId === 'fresh');
    expect(fresh?.marginPerSqFt).toEqual({ kind: 'per_sq_ft', minorPerSqFt: 250 }); // ₹2.50/sq ft
    const grocery = result.find((r) => r.areaId === 'grocery');
    expect(grocery?.salesPerSqFt).toEqual({ kind: 'per_sq_ft', minorPerSqFt: 1_000 });
    expect(grocery?.marginPerSqFt).toEqual({ kind: 'per_sq_ft', minorPerSqFt: 50 });
  });

  it('flags the area taking more space than it earns', () => {
    const household = result.find((r) => r.areaId === 'household');
    // 50% of the floor, 12.5% of the margin.
    expect(household?.shareOfSpaceBp).toBe(4_000);
    expect(household?.shareOfMarginBp).toBe(1_250);
    expect(household?.underperforming).toBe(true);
    expect(result.find((r) => r.areaId === 'fresh')?.underperforming).toBe(false);
  });

  it('says "not meaningful" rather than zero when an area has no measured floor', () => {
    const unmeasured = spacePerformance({
      areas: [{ areaId: 'x', storeId: 'store-1', name: 'Unmeasured', squareFeet: 0 }],
      sales: { x: money(5_000_00, INR) },
      grossMargin: { x: money(500_00, INR) },
      currency: INR,
    });
    // "0 per sq ft" and "we never measured this" lead to opposite decisions.
    expect(unmeasured[0]?.salesPerSqFt).toEqual({
      kind: 'not_meaningful',
      because: 'this area has no recorded floor space',
    });
  });
});

describe('reviewDisplayContracts — is the supplier paying for the end-cap?', () => {
  function contract(over: Partial<DisplayContract> = {}): DisplayContract {
    return {
      contractId: 'dc-1',
      storeId: 'store-1',
      supplierId: 'sup-1',
      description: 'End-cap, aisle 2',
      locationIds: ['L-B3'],
      fundingAmount: money(50_000_00, INR),
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
      approvedBy: 'finance-1',
      ...over,
    };
  }

  it('reports an active, fully funded contract as active', () => {
    const rows = reviewDisplayContracts({
      contracts: [contract()],
      onDate: TODAY,
      received: { 'dc-1': money(50_000_00, INR) },
      currency: INR,
    });
    expect(rows[0]?.finding).toBe('active');
    expect(rows[0]?.outstanding.minor).toBe(0);
  });

  it('catches the expensive one: expired and the display is STILL on the floor', () => {
    const rows = reviewDisplayContracts({
      contracts: [contract({ endsOn: '2026-06-30' })],
      onDate: TODAY,
      received: { 'dc-1': money(50_000_00, INR) },
      stillOccupying: ['dc-1'],
      currency: INR,
    });
    expect(rows[0]?.finding).toBe('expired_still_occupying');
    expect(rows[0]?.detail).toContain('the shop is giving away its best space');
  });

  it('catches space being used while the money is not in (M23)', () => {
    const rows = reviewDisplayContracts({
      contracts: [contract()],
      onDate: TODAY,
      received: { 'dc-1': money(20_000_00, INR) },
      currency: INR,
    });
    expect(rows[0]?.finding).toBe('funding_not_received');
    expect(rows[0]?.outstanding).toEqual(money(30_000_00, INR));
  });

  it('refuses to treat an unapproved or unlocated contract as normal', () => {
    expect(
      reviewDisplayContracts({ contracts: [contract({ approvedBy: undefined })], onDate: TODAY, currency: INR })[0]
        ?.finding,
    ).toBe('unapproved');
    expect(
      reviewDisplayContracts({
        contracts: [contract({ locationIds: [], areaId: undefined })],
        onDate: TODAY,
        received: { 'dc-1': money(50_000_00, INR) },
        currency: INR,
      })[0]?.finding,
    ).toBe('no_space_named');
  });

  it('warns before it expires, worst first', () => {
    const rows = reviewDisplayContracts({
      contracts: [
        contract({ contractId: 'dc-far', endsOn: '2026-12-31' }),
        contract({ contractId: 'dc-soon', endsOn: '2026-08-20' }),
      ],
      onDate: TODAY,
      received: { 'dc-far': money(50_000_00, INR), 'dc-soon': money(50_000_00, INR) },
      currency: INR,
    });
    expect(rows.map((r) => r.contractId)).toEqual(['dc-soon', 'dc-far']);
    expect(rows[0]?.finding).toBe('expiring_soon');
  });
});
