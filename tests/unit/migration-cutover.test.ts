import { describe, it, expect } from 'vitest';
import {
  compareParallelDay, ownDifference, parallelRunPosition, decideCutover, performRollback,
  type CutoverChecklist, type DayComparison, type ParallelDayResult,
} from '../../packages/migration/src/cutover';
import * as cutover from '../../packages/migration/src/cutover';

// MG-10 / MG-11 — the only step that tests the new system against reality, and the rollback that
// is the real deliverable.

const comparison = (over: Partial<DayComparison> = {}): DayComparison => ({
  area: 'sales_value', legacyValue: 41_20_000, newValue: 41_20_000, toleranceMinor: 100, ...over,
});

describe('a parallel run compares a day of trading, not a load to an extract', () => {
  it('is clean when both systems agree within tolerance', () => {
    const r = compareParallelDay({
      tenantId: 't-sre', businessDate: '2026-09-01',
      comparisons: [comparison(), comparison({ area: 'tax', legacyValue: 206_000, newValue: 206_040 })],
    });
    expect(r.clean).toBe(true);
    expect(r.differences).toHaveLength(0);
  });

  it('raises a difference beyond tolerance, OPEN and UNOWNED', () => {
    const r = compareParallelDay({
      tenantId: 't-sre', businessDate: '2026-09-02',
      comparisons: [comparison({ newValue: 41_20_000 - 4_500 })],
    });
    expect(r.clean).toBe(false);
    expect(r.differences[0]?.status).toBe('open');
    expect(r.differences[0]?.ownerUserId).toBeUndefined();
    expect(r.totalDifferenceMinor).toBe(4_500);
    expect(r.detail).toContain('by day five nobody can tell a new fault from an old one');
  });

  it('reports a difference in every area separately — one figure hides which system is wrong', () => {
    const r = compareParallelDay({
      tenantId: 't-sre', businessDate: '2026-09-03',
      comparisons: [
        comparison({ newValue: 41_20_000 - 4_500 }),
        comparison({ area: 'stock_movement', legacyValue: 800, newValue: 812, toleranceMinor: 0 }),
      ],
    });
    expect(r.differences.map((d) => d.area).sort()).toEqual(['sales_value', 'stock_movement']);
  });
});

describe('a difference is never resolved by preferring the newer system (hard rule #10)', () => {
  const day = compareParallelDay({
    tenantId: 't-sre', businessDate: '2026-09-02',
    comparisons: [comparison({ newValue: 41_20_000 - 4_500 })],
  });
  const id = day.differences[0]!.differenceId;

  it('owns a difference without yet explaining it', () => {
    const r = ownDifference({ differences: day.differences, differenceId: id, ownerUserId: 'u-manager' });
    expect(r.ok).toBe(true);
    expect(r.differences[0]?.status).toBe('owned');
    expect(r.detail).toContain('still to be explained');
  });

  it('resolves with a real explanation and records WHICH system was wrong', () => {
    const r = ownDifference({
      differences: day.differences, differenceId: id, ownerUserId: 'u-manager',
      explanation: 'a cash refund was keyed into the old system twice by the evening cashier',
      wrongSide: 'legacy',
    });
    expect(r.differences[0]?.status).toBe('resolved');
    expect(r.differences[0]?.wrongSide).toBe('legacy');
  });

  it('REFUSES "the new system is probably right" and its relatives', () => {
    for (const explanation of [
      'the new system is right', 'the new system is probably right', 'legacy is wrong',
      'took the newer figure', 'assumed the new one', 'last write wins', 'ignored the old value',
    ]) {
      const r = ownDifference({ differences: day.differences, differenceId: id, ownerUserId: 'u-manager', explanation });
      expect(r.ok, explanation).toBe(false);
      expect(r.refusedBecause).toBe('newer_is_not_a_reason');
    }
    expect(ownDifference({ differences: day.differences, differenceId: id, ownerUserId: 'u-manager', explanation: 'last write wins' }).detail)
      .toContain('surfaces at a count six weeks later');
  });

  it('refuses an unnamed owner and a second resolution', () => {
    expect(ownDifference({ differences: day.differences, differenceId: id, ownerUserId: ' ' }).refusedBecause).toBe('no_owner');
    const resolved = ownDifference({ differences: day.differences, differenceId: id, ownerUserId: 'u-manager', explanation: 'keying error at the old till' }).differences;
    expect(ownDifference({ differences: resolved, differenceId: id, ownerUserId: 'u-other', explanation: 'something else' }).refusedBecause).toBe('already_resolved');
  });
});

describe('clean days are counted CONSECUTIVELY', () => {
  const day = (businessDate: string, clean: boolean): ParallelDayResult => ({
    tenantId: 't-sre', businessDate, differences: [], clean, totalDifferenceMinor: 0, detail: '',
  });

  it('counts a straight run', () => {
    const p = parallelRunPosition({
      days: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'].map((d) => day(d, true)),
      differences: [], requiredCleanDays: 5,
    });
    expect(p.consecutiveCleanDays).toBe(5);
    expect(p.sufficient).toBe(true);
  });

  it('RESETS on a bad day — clean-bad-clean-clean-clean is three days of evidence, not four', () => {
    const p = parallelRunPosition({
      days: [day('2026-09-01', true), day('2026-09-02', false), day('2026-09-03', true), day('2026-09-04', true), day('2026-09-05', true)],
      differences: [], requiredCleanDays: 5,
    });
    expect(p.daysRun).toBe(5);
    expect(p.consecutiveCleanDays).toBe(3);
    expect(p.sufficient).toBe(false);
  });

  it('is not sufficient while any difference is open, however many clean days follow', () => {
    const p = parallelRunPosition({
      days: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'].map((d) => day(d, true)),
      differences: [{
        differenceId: 'pd-1', tenantId: 't-sre', businessDate: '2026-08-28', area: 'tax',
        difference: -12_400, status: 'owned', ownerUserId: 'u-manager',
      }],
      requiredCleanDays: 5,
    });
    expect(p.consecutiveCleanDays).toBe(5);
    expect(p.sufficient).toBe(false);
    expect(p.valueAtStakeMinor).toBe(12_400);
  });

  it('counts differences nobody has claimed separately', () => {
    const p = parallelRunPosition({
      days: [day('2026-09-01', true)],
      differences: [
        { differenceId: 'pd-1', tenantId: 't-sre', businessDate: '2026-08-28', area: 'tax', difference: 100, status: 'open' },
        { differenceId: 'pd-2', tenantId: 't-sre', businessDate: '2026-08-28', area: 'payments', difference: 50, status: 'owned', ownerUserId: 'u-manager' },
      ],
      requiredCleanDays: 3,
    });
    expect(p.unownedDifferences).toHaveLength(1);
    expect(p.detail).toContain("with nobody's name on them");
  });
});

describe('the rollback is the deliverable, not the cutover', () => {
  const checklist = (over: Partial<CutoverChecklist> = {}): CutoverChecklist => ({
    cutoverId: 'cut-1', tenantId: 't-sre', qg07Passed: true,
    rollbackDemonstratedAt: '2026-09-10T22:00:00Z', parallelRunSufficient: true,
    edgeUnsyncedItems: 0, blockingExceptionsOpen: 0, deltaApplied: true,
    namedTeam: [{ userId: 'u-operator', role: 'load' }, { userId: 'u-manager', role: 'floor' }],
    ownerGoBy: 'u-owner', ...over,
  });

  it('gives GO when all eight checks pass', () => {
    const d = decideCutover(checklist());
    expect(d.go).toBe(true);
    expect(d.failed).toHaveLength(0);
  });

  it('REFUSES GO without a DEMONSTRATED rollback', () => {
    const d = decideCutover(checklist({ rollbackDemonstratedAt: undefined }));
    expect(d.go).toBe(false);
    expect(d.failed).toEqual(['rollback_demonstrated']);
    expect(d.detail).toContain('made at 6am by a tired person');
  });

  it('refuses GO while the store edge holds unsynced items (P-01)', () => {
    const d = decideCutover(checklist({ edgeUnsyncedItems: 3 }));
    expect(d.failed).toContain('edge_fully_synced');
    expect(d.detail).toContain('an unsynced till is an unmigrated sale');
  });

  it('names EVERY failed check at once, not the first', () => {
    const d = decideCutover(checklist({
      qg07Passed: false, rollbackDemonstratedAt: undefined, parallelRunSufficient: false,
      edgeUnsyncedItems: 2, blockingExceptionsOpen: 5, deltaApplied: false, namedTeam: [], ownerGoBy: undefined,
    }));
    expect(d.failed).toHaveLength(8);
    expect([...d.failed].sort()).toEqual([
      'blocking_exceptions_cleared', 'control_totals_signed', 'delta_applied', 'edge_fully_synced',
      'owner_go', 'parallel_run_sufficient', 'rollback_demonstrated', 'team_named',
    ]);
  });

  it('tells the owner plainly when the decision is his and when it is not', () => {
    expect(decideCutover(checklist({ ownerGoBy: undefined })).ownerAction).toContain('waits on your GO');
    expect(decideCutover(checklist({ ownerGoBy: undefined, deltaApplied: false })).ownerAction).toContain('ours to clear first');
    expect(decideCutover(checklist()).ownerAction).toContain('nothing further');
  });

  it('keeps the shop trading whichever way the decision goes (P-01)', () => {
    const go: true = decideCutover(checklist()).shopKeepsTrading;
    const noGo: true = decideCutover(checklist({ ownerGoBy: undefined })).shopKeepsTrading;
    expect([go, noGo]).toEqual([true, true]);
  });
});

describe('a rollback needs no committee, and unwinds no evidence', () => {
  it('is performed by the person on the night', () => {
    const r = performRollback({
      cutoverId: 'cut-1', trigger: 'control_total_failed', decidedBy: 'u-manager',
      legacySystemAvailable: true, now: '2026-09-15T05:40:00Z',
    });
    expect(r.performed).toBe(true);
    expect(r.evidenceRetained).toBe(true);
    expect(r.detail).toContain('every piece of migration evidence is retained for the second attempt');
  });

  it('says so loudly when the legacy system is NOT there to fall back to', () => {
    const r = performRollback({
      cutoverId: 'cut-1', trigger: 'data_corruption', decidedBy: 'u-manager',
      legacySystemAvailable: false, now: '2026-09-15T05:40:00Z',
    });
    expect(r.detail).toContain('MG-12 does not retire it on the strength of one good night');
  });

  it('exposes no approval gate on the rollback path, and no way to discard the evidence', () => {
    const names = Object.keys(cutover);
    for (const forbidden of ['approveRollback', 'requestRollbackApproval', 'discardCutoverEvidence', 'clearDifferences', 'forceGo']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
