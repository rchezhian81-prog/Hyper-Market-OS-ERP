import { describe, it, expect } from 'vitest';
import {
  drillThrough,
  compareBy,
  auditDrill,
  type SourceTransaction,
  type DataScope,
} from '../../packages/owner-control/src/drill-through';

// M29-FR-02 acceptance: "a KPI DRILLS TO THE EXACT TRANSACTIONS behind it; comparisons
// reconcile to the KPIs; SCOPE IS ENFORCED ON DRILL."

const TX: SourceTransaction[] = [
  { transactionId: 'S-1', at: '2026-08-04T10:00:00Z', branchId: 'store-1', categoryId: 'fresh', staffId: 'u-a', vendorId: 'v-1', amountMinor: 120_000, description: 'Basket 1' },
  { transactionId: 'S-2', at: '2026-08-04T12:00:00Z', branchId: 'store-1', categoryId: 'grocery', staffId: 'u-b', vendorId: 'v-2', amountMinor: 80_000, description: 'Basket 2' },
  { transactionId: 'S-3', at: '2026-08-04T14:00:00Z', branchId: 'branch-2', categoryId: 'fresh', staffId: 'u-c', vendorId: 'v-1', amountMinor: 200_000, description: 'Basket 3' },
];

const OWNER: DataScope = { userId: 'u-owner', branchScope: 'all' };
const BRANCH_MANAGER: DataScope = { userId: 'u-mgr-1', branchScope: ['store-1'] };

describe('a drill reaches the exact transactions and must add up (M29-FR-02)', () => {
  it('lists them newest first and confirms they equal the figure clicked', () => {
    const result = drillThrough({ metric: 'net sales', kpiValueMinor: 400_000, transactions: TX, scope: OWNER });
    expect(result.reconciles).toBe(true);
    expect(result.transactions.map((t) => t.transactionId)).toEqual(['S-3', 'S-2', 'S-1']);
    expect(result.shownTotalMinor).toBe(400_000);
    expect(result.detail).toContain('exactly the figure you clicked');
    expect(result.discrepancy).toBeUndefined();
  });

  it('SAYS SO LOUDLY when the transactions do not add up to the KPI', () => {
    // The KPI says ₹4,500.00 but the transactions behind it total ₹4,000.00.
    const result = drillThrough({ metric: 'net sales', kpiValueMinor: 450_000, transactions: TX, scope: OWNER });
    expect(result.reconciles).toBe(false);
    expect(result.discrepancy).toContain('DO NOT ADD UP');
    expect(result.discrepancy).toContain('Do not act on this until it is explained');
    expect(result.discrepancy).toContain('50000');
  });
});

describe('scope is enforced, and the number changes with it', () => {
  it('shows only the branch manager\'s own branch and recomputes the total', () => {
    const result = drillThrough({ metric: 'net sales', kpiValueMinor: 400_000, transactions: TX, scope: BRANCH_MANAGER });
    expect(result.transactions.map((t) => t.transactionId)).toEqual(['S-2', 'S-1']);
    expect(result.shownTotalMinor).toBe(200_000);
    expect(result.withheldCount).toBe(1);
    expect(result.withheldTotalMinor).toBe(200_000);
    // It still reconciles: shown + withheld = the headline.
    expect(result.reconciles).toBe(true);
  });

  it('TELLS the viewer money exists that they cannot see, rather than showing a mismatched total', () => {
    const result = drillThrough({ metric: 'net sales', kpiValueMinor: 400_000, transactions: TX, scope: BRANCH_MANAGER });
    expect(result.detail).toContain('outside your access and are not shown');
    expect(result.detail).toContain('the headline figure includes them');
  });

  it('still catches a genuine discrepancy inside a scoped view', () => {
    const result = drillThrough({ metric: 'net sales', kpiValueMinor: 999_000, transactions: TX, scope: BRANCH_MANAGER });
    expect(result.reconciles).toBe(false);
    expect(result.discrepancy).toBeDefined();
  });
});

describe('comparisons reconcile to the KPI they came from', () => {
  it('ranks a dimension with exact basis-point shares', () => {
    const result = compareBy({ dimension: 'category', metric: 'net sales', transactions: TX, scope: OWNER });
    expect(result.reconciles).toBe(true);
    expect(result.totalMinor).toBe(400_000);
    expect(result.rows.map((r) => [r.key, r.valueMinor, r.shareBps])).toEqual([
      ['fresh', 320_000, 8_000],
      ['grocery', 80_000, 2_000],
    ]);
  });

  it('GROUPS unattributed rows rather than dropping them', () => {
    // A transaction with no vendor. Dropping it would make the rows sum to less than
    // the total, and whoever noticed would assume the money went somewhere specific.
    const withGap: SourceTransaction[] = [...TX, { ...TX[0]!, transactionId: 'S-4', vendorId: undefined, amountMinor: 50_000 }];
    const result = compareBy({ dimension: 'vendor', metric: 'net sales', transactions: withGap, scope: OWNER });
    expect(result.reconciles).toBe(true);
    const unattributed = result.rows.find((r) => r.key === 'unattributed');
    expect(unattributed?.valueMinor).toBe(50_000);
    expect(unattributed?.label).toContain('no value recorded');
  });

  it('honours scope, so a branch manager\'s comparison covers their branch only', () => {
    const result = compareBy({ dimension: 'staff', metric: 'net sales', transactions: TX, scope: BRANCH_MANAGER });
    expect(result.rows.map((r) => r.key)).toEqual(['u-a', 'u-b']);
    expect(result.totalMinor).toBe(200_000);
  });

  it('uses supplied labels and handles an empty set without dividing by zero', () => {
    const labelled = compareBy({
      dimension: 'branch', metric: 'net sales', transactions: TX, scope: OWNER,
      labels: { 'store-1': 'SRE Hyper Market', 'branch-2': 'SRE Express' },
    });
    expect(labelled.rows[0]?.label).toBe('SRE Express');

    const empty = compareBy({ dimension: 'branch', metric: 'net sales', transactions: [], scope: OWNER });
    expect(empty.rows).toEqual([]);
    expect(empty.totalMinor).toBe(0);
    expect(empty.reconciles).toBe(true);
  });
});

describe('every drill is logged', () => {
  it('records who looked at what, and whether it reconciled', () => {
    const result = drillThrough({ metric: 'net sales', kpiValueMinor: 400_000, transactions: TX, scope: BRANCH_MANAGER });
    const audit = auditDrill(result, BRANCH_MANAGER, '2026-08-05T09:00:00Z');
    expect(audit).toEqual({
      userId: 'u-mgr-1',
      metric: 'net sales',
      at: '2026-08-05T09:00:00Z',
      transactionsShown: 2,
      transactionsWithheld: 1,
      reconciled: true,
    });
  });
});
