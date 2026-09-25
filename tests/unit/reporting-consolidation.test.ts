import { describe, it, expect } from 'vitest';
import {
  ingestContribution,
  resolveHierarchyAsOf,
  branchesUnder,
  visibleBranches,
  consolidate,
  type BranchContribution,
  type BranchMembership,
  type ReportScope,
} from '../../packages/reporting/src/index';

// Company-wide consolidation (M01 / M29 / D13, owner decision) — org roll-ups + drill-down. Idempotent
// branch ingestion; corrections supersede; effective-dated hierarchy; provenance + worst-freshness; missing
// branches named; reconciliation; scope-enforced totals (§28); exact-integer money (§29.1).

const contrib = (over: Partial<BranchContribution>): BranchContribution => ({
  branchId: 'br-1',
  period: '2026-09',
  family: 'sales',
  measures: { grossMinor: 100000, netMinor: 90000, marginMinor: 30000 },
  lastRefreshAt: '2026-09-25T09:00:00.000Z',
  revision: 1,
  ...over,
});

// br-1 and br-2 under company co-1 for the whole period; br-3 opens mid-period (from the 20th).
const memberships: BranchMembership[] = [
  { branchId: 'br-1', parentId: 'co-1', from: '2026-01-01', to: null },
  { branchId: 'br-2', parentId: 'co-1', from: '2026-01-01', to: null },
  { branchId: 'br-3', parentId: 'co-1', from: '2026-09-20', to: null },
];

const ALL: ReportScope = { userId: 'owner', branchScope: 'all' };

describe('ingestContribution — idempotent, corrections supersede, stale refused (hard rule #10)', () => {
  it('ingests the first contribution', () => {
    const r = ingestContribution([], contrib({}));
    expect(r.outcome).toBe('ingested');
    expect(r.store).toHaveLength(1);
  });

  it('ignores a duplicate at the same revision — never counts twice', () => {
    const first = ingestContribution([], contrib({})).store;
    const again = ingestContribution(first, contrib({ measures: { grossMinor: 999999 } }));
    expect(again.outcome).toBe('ignored_duplicate');
    expect(again.store).toHaveLength(1);
    expect(again.store[0]?.measures['grossMinor']).toBe(100000); // held value unchanged
  });

  it('a higher revision REPLACES (late/corrected data)', () => {
    const first = ingestContribution([], contrib({})).store;
    const corrected = ingestContribution(first, contrib({ revision: 2, measures: { grossMinor: 120000, netMinor: 108000, marginMinor: 36000 } }));
    expect(corrected.outcome).toBe('replaced_by_correction');
    expect(corrected.store).toHaveLength(1);
    expect(corrected.store[0]?.measures['grossMinor']).toBe(120000);
  });

  it('a lower revision is REFUSED, never applied (out-of-order arrival)', () => {
    const held = ingestContribution([], contrib({ revision: 3 })).store;
    const late = ingestContribution(held, contrib({ revision: 2, measures: { grossMinor: 1 } }));
    expect(late.outcome).toBe('refused_stale_revision');
    expect(late.store[0]?.measures['grossMinor']).toBe(100000);
  });

  it('keys separately by branch, period and family', () => {
    let store: readonly BranchContribution[] = [];
    store = ingestContribution(store, contrib({ branchId: 'br-1', family: 'sales' })).store;
    store = ingestContribution(store, contrib({ branchId: 'br-2', family: 'sales' })).store;
    store = ingestContribution(store, contrib({ branchId: 'br-1', family: 'returns', measures: { countMinor: 5 } })).store;
    store = ingestContribution(store, contrib({ branchId: 'br-1', period: '2026-08' })).store;
    expect(store).toHaveLength(4);
  });
});

describe('resolveHierarchyAsOf — the structure in force AT the period, not today', () => {
  it('includes a branch only within its validity window', () => {
    const early = resolveHierarchyAsOf(memberships, '2026-09-10');
    expect(branchesUnder('co-1', early)).toEqual(['br-1', 'br-2']); // br-3 not yet open
    const late = resolveHierarchyAsOf(memberships, '2026-09-25');
    expect(branchesUnder('co-1', late)).toEqual(['br-1', 'br-2', 'br-3']); // br-3 now open
  });

  it('a branch that moved companies is attributed to the one in force at the time', () => {
    const moved: BranchMembership[] = [
      { branchId: 'br-x', parentId: 'co-1', from: '2026-01-01', to: '2026-06-01' },
      { branchId: 'br-x', parentId: 'co-2', from: '2026-06-01', to: null },
    ];
    expect(branchesUnder('co-1', resolveHierarchyAsOf(moved, '2026-05-01'))).toEqual(['br-x']);
    expect(branchesUnder('co-1', resolveHierarchyAsOf(moved, '2026-07-01'))).toEqual([]);
    expect(branchesUnder('co-2', resolveHierarchyAsOf(moved, '2026-07-01'))).toEqual(['br-x']);
  });
});

describe('visibleBranches — scope enforced (§28)', () => {
  it("'all' sees the whole population; a scoped viewer sees only theirs", () => {
    const pop = ['br-1', 'br-2', 'br-3'];
    expect(visibleBranches(ALL, pop)).toEqual(pop);
    expect(visibleBranches({ userId: 'mgr', branchScope: ['br-2'] }, pop)).toEqual(['br-2']);
  });
});

describe('consolidate — roll up, reconcile, carry provenance, enforce scope', () => {
  const asOf = '2026-09-25T10:00:00.000Z';

  it('sums exact-integer measures across the branches that reported', () => {
    const contributions = [
      contrib({ branchId: 'br-1', measures: { grossMinor: 100000, netMinor: 90000, marginMinor: 30000 } }),
      contrib({ branchId: 'br-2', measures: { grossMinor: 250000, netMinor: 225000, marginMinor: 60000 } }),
    ];
    // As of the 10th, only br-1 and br-2 are open.
    const r = consolidate({ nodeId: 'co-1', family: 'sales', period: '2026-09', contributions, memberships, scope: ALL, asOf: '2026-09-10T10:00:00.000Z', staleAfterSeconds: 86_400 });
    expect(r.measures).toEqual({ grossMinor: 350000, netMinor: 315000, marginMinor: 90000 });
    expect(r.reportedBranches).toEqual(['br-1', 'br-2']);
    expect(r.reconciles).toBe(true);
    expect(r.missingBranches).toEqual([]);
  });

  it('names a MISSING branch and does not reconcile (P-08)', () => {
    const contributions = [contrib({ branchId: 'br-1' })]; // br-2 open but silent
    const r = consolidate({ nodeId: 'co-1', family: 'sales', period: '2026-09', contributions, memberships, scope: ALL, asOf: '2026-09-10T10:00:00.000Z', staleAfterSeconds: 86_400 });
    expect(r.reconciles).toBe(false);
    expect(r.missingBranches).toEqual(['br-2']);
    expect(r.detail).toContain('MISSING');
  });

  it('carries the WORST freshness and names stale branches — never shows stale as fresh', () => {
    const contributions = [
      contrib({ branchId: 'br-1', lastRefreshAt: '2026-09-25T09:30:00.000Z' }), // fresh (30m)
      contrib({ branchId: 'br-2', lastRefreshAt: '2026-09-23T09:00:00.000Z' }), // stale (>1 day)
    ];
    const r = consolidate({ nodeId: 'co-1', family: 'sales', period: '2026-09', contributions, memberships, scope: ALL, asOf, staleAfterSeconds: 86_400 });
    expect(r.freshness.state).toBe('stale');
    expect(r.staleBranches).toEqual(['br-2']);
  });

  it('a branch that never synced makes the roll-up MISSING freshness', () => {
    const contributions = [
      contrib({ branchId: 'br-1', lastRefreshAt: '2026-09-25T09:30:00.000Z' }),
      contrib({ branchId: 'br-2', lastRefreshAt: null }),
    ];
    const r = consolidate({ nodeId: 'co-1', family: 'sales', period: '2026-09', contributions, memberships, scope: ALL, asOf, staleAfterSeconds: 86_400 });
    expect(r.freshness.state).toBe('missing');
  });

  it('enforces scope and names what was withheld; the total changes with it (§28)', () => {
    const contributions = [
      contrib({ branchId: 'br-1', measures: { grossMinor: 100000 } }),
      contrib({ branchId: 'br-2', measures: { grossMinor: 250000 } }),
    ];
    const scoped: ReportScope = { userId: 'mgr-1', branchScope: ['br-1'] };
    const r = consolidate({ nodeId: 'co-1', family: 'sales', period: '2026-09', contributions, memberships, scope: scoped, asOf: '2026-09-10T10:00:00.000Z', staleAfterSeconds: 86_400 });
    expect(r.expectedBranches).toEqual(['br-1']);
    expect(r.measures['grossMinor']).toBe(100000); // br-2 not in the total
    expect(r.withheldByScope).toEqual(['br-2']);
    expect(r.reconciles).toBe(true); // reconciles against the visible population
  });

  it('provides a worst-first drill-down (contributors) for the same node', () => {
    const contributions = [
      contrib({ branchId: 'br-1', measures: { grossMinor: 100000 } }),
      contrib({ branchId: 'br-2', measures: { grossMinor: 250000 } }),
    ];
    const r = consolidate({ nodeId: 'co-1', family: 'sales', period: '2026-09', contributions, memberships, scope: ALL, asOf: '2026-09-10T10:00:00.000Z', staleAfterSeconds: 86_400 });
    expect(r.contributors.map((c) => c.branchId)).toEqual(['br-2', 'br-1']); // 250000 before 100000
  });

  it('works for a non-sales family with its own measures (returns)', () => {
    const contributions = [
      contrib({ branchId: 'br-1', family: 'returns', measures: { refundMinor: 4000, count: 3 } }),
      contrib({ branchId: 'br-2', family: 'returns', measures: { refundMinor: 1500, count: 1 } }),
    ];
    const r = consolidate({ nodeId: 'co-1', family: 'returns', period: '2026-09', contributions, memberships, scope: ALL, asOf: '2026-09-10T10:00:00.000Z', staleAfterSeconds: 86_400 });
    expect(r.measures).toEqual({ refundMinor: 5500, count: 4 });
  });
});
