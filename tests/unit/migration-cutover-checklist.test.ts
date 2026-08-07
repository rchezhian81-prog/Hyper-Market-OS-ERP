import { describe, it, expect } from 'vitest';
import {
  buildCutoverChecklist, decideCutover, assessReconciliation, outstandingExceptions,
  parallelRunPosition,
  type ControlTotal, type CutoverEvidence, type MigrationException, type ParallelDayResult,
  type ParallelDifference,
} from '../../packages/migration/src/index';

/**
 * **The cutover checklist, derived — MG-11 (QG-07, P-01, P-08).**
 *
 * `decideCutover` refuses GO until all eight checks pass and has done since the day it was
 * written. It takes those eight as **booleans supplied by the caller**, and in every call site in
 * this codebase — both integration tests and its own unit test — every one of them is typed in by
 * hand: `qg07Passed: true`, `parallelRunSufficient: true`, `edgeUnsyncedItems: 0`.
 *
 * So the gate on the single most irreversible action in this project has never once been asked
 * about the state of the migration. It has only ever been told.
 *
 * The rules under test:
 *
 *   • **every check is derived from a real producer**, and the same producers the pipeline uses;
 *   • **NOT KNOWN FAILS** — an absent input never becomes a comfortable default, and the unsynced
 *     count in particular is never `?? 0`;
 *   • **an unanswerable check is reported as its own thing**, because a failed check is work to
 *     finish and an unanswerable one is a producer that is not connected;
 *   • and whichever way it goes, **the shop keeps trading** (P-01).
 */

const CUTOVER = { cutoverId: 'cut-1', tenantId: 't-sre' } as const;

const total = (over: Partial<ControlTotal> = {}): ControlTotal => ({
  totalId: 'CT-1', tenantId: 't-sre', kind: 'migration', name: 'Product rows',
  unit: 'rows', legacyValue: 41_200, loadedValue: 41_200,
  legacyDerivation: 'count(*) on the legacy product table',
  loadedDerivation: 'count(*) on the loaded product table',
  signature: {
    signedBy: 'u-owner', signerRole: 'owner', signedAt: '2026-09-01T11:00:00.000Z',
    statement: 'I have checked the product row count against the printed report',
  },
  ...over,
});

const exception = (over: Partial<MigrationException> = {}): MigrationException => ({
  exceptionId: 'EX-1', tenantId: 't-sre', kind: 'negative_stock', severity: 'blocking',
  confidence: 'certain', legacyIds: ['p-9'], evidence: 'stock on hand is -4 for toor dal 1kg',
  ...over,
});

const cleanDay = (businessDate: string): ParallelDayResult => ({
  tenantId: 't-sre', businessDate, differences: [], clean: true,
  totalDifferenceMinor: 0, detail: 'both systems agree',
});

const badDay = (businessDate: string, difference: ParallelDifference): ParallelDayResult => ({
  tenantId: 't-sre', businessDate, differences: [difference], clean: false,
  totalDifferenceMinor: Math.abs(difference.difference), detail: 'they disagree',
});

const difference = (over: Partial<ParallelDifference> = {}): ParallelDifference => ({
  differenceId: 'PD-1', tenantId: 't-sre', businessDate: '2026-09-05',
  area: 'sales_value', difference: 4_500, status: 'open',
  ...over,
});

/** Everything answered, everything good. The only shape that may reach GO. */
const READY: CutoverEvidence = {
  reconciliation: assessReconciliation({ tenantId: 't-sre', totals: [total()] }),
  parallel: parallelRunPosition({
    days: [cleanDay('2026-09-01'), cleanDay('2026-09-02'), cleanDay('2026-09-03')],
    differences: [], requiredCleanDays: 3,
  }),
  exceptions: outstandingExceptions([exception({ resolution: {
    action: 'correct', decidedBy: 'u-manager', decidedAt: '2026-09-02T09:00:00.000Z',
    reason: 'counted the shelf and set it to 4',
  } })]),
  edgeUnsyncedItems: 0,
  deltaAppliedAt: '2026-09-10T21:00:00.000Z',
  rollbackDemonstratedAt: '2026-09-08T22:00:00.000Z',
  namedTeam: [{ userId: 'u-owner', role: 'decision' }, { userId: 'u-eng', role: 'load' }],
  ownerGoBy: 'u-owner',
};

const build = (evidence: CutoverEvidence) => buildCutoverChecklist({ ...CUTOVER, evidence });
const decide = (evidence: CutoverEvidence) => decideCutover(build(evidence).checklist);

// ── The producer that never existed ─────────────────────────────────────────

describe('every one of the eight is derived, not asserted', () => {
  it('reaches GO when all eight are answered from evidence and all eight are good', () => {
    const decision = decide(READY);
    expect(decision.go, decision.detail).toBe(true);
    expect(build(READY).notKnown).toEqual([]);
  });

  it('takes QG-07 from the signed control totals, never from a flag', () => {
    const unsigned = assessReconciliation({
      tenantId: 't-sre', totals: [total({ signature: undefined })],
    });
    expect(unsigned.qg07Passed).toBe(false);
    const decision = decide({ ...READY, reconciliation: unsigned });
    expect(decision.failed).toContain('control_totals_signed');
  });

  it('takes the parallel run from CONSECUTIVE clean days', () => {
    // Clean, bad, clean, clean is three clean days and two days of evidence.
    const broken = parallelRunPosition({
      days: [cleanDay('2026-09-01'), badDay('2026-09-02', difference()), cleanDay('2026-09-03'), cleanDay('2026-09-04')],
      differences: [difference()], requiredCleanDays: 3,
    });
    expect(broken.consecutiveCleanDays).toBe(2);
    expect(decide({ ...READY, parallel: broken }).failed).toContain('parallel_run_sufficient');
  });

  it('takes the blocking exceptions from the ones with no decision', () => {
    const undecided = outstandingExceptions([exception()]);
    expect(undecided.blockingUnresolved).toHaveLength(1);
    expect(decide({ ...READY, exceptions: undecided }).failed).toContain('blocking_exceptions_cleared');
  });

  it('accepts a blocking exception the owner knowingly decided to migrate as it is', () => {
    // Cleared by a DECISION, including a decision to carry it. What is not permitted is for it
    // to be unexamined.
    const decided = outstandingExceptions([exception({ resolution: {
      action: 'migrate_as_is', decidedBy: 'u-owner', decidedAt: '2026-09-02T09:00:00.000Z',
      reason: 'the supplier confirmed the stock was written off in July and we carry the zero',
    } })]);
    expect(decide({ ...READY, exceptions: decided }).failed).not.toContain('blocking_exceptions_cleared');
  });

  it('fails on a rollback that was designed rather than performed', () => {
    const decision = decide({ ...READY, rollbackDemonstratedAt: undefined });
    expect(decision.failed).toEqual(['rollback_demonstrated']);
    expect(decision.detail).toContain('DEMONSTRATED');
  });

  it('fails on unsynced items on the store box', () => {
    expect(decide({ ...READY, edgeUnsyncedItems: 4 }).failed).toContain('edge_fully_synced');
  });

  it('fails with nobody named for the night', () => {
    expect(decide({ ...READY, namedTeam: [] }).failed).toContain('team_named');
  });

  it('waits on the owner when every technical check has passed', () => {
    const decision = decide({ ...READY, ownerGoBy: undefined });
    expect(decision.failed).toEqual(['owner_go']);
    expect(decision.ownerAction).toContain('waits on your GO');
  });
});

// ── Not known fails ─────────────────────────────────────────────────────────

describe('what nobody could answer is never answered comfortably', () => {
  it('refuses everything when nothing at all is known', () => {
    const derived = build({});
    const decision = decideCutover(derived.checklist);
    expect(decision.go).toBe(false);
    expect(decision.failed).toHaveLength(8);
    // Four of the eight are genuinely unanswerable rather than answered badly.
    expect([...derived.notKnown].sort()).toEqual([
      'blocking_exceptions_cleared', 'control_totals_signed', 'edge_fully_synced',
      'parallel_run_sufficient', 'team_named',
    ].sort());
  });

  it('never turns an unknown unsynced count into a clear one', () => {
    // The single most dangerous default in this file. `?? 0` here reads as "all clear" on a box
    // that was simply never asked, and an unsynced till is an unmigrated sale.
    const derived = build({ ...READY, edgeUnsyncedItems: undefined });
    expect(derived.checklist.edgeUnsyncedItems).toBeGreaterThan(0);
    expect(decideCutover(derived.checklist).failed).toContain('edge_fully_synced');
    expect(derived.notKnown).toContain('edge_fully_synced');
  });

  it('never turns a cleaning pass that never ran into a clean one', () => {
    const derived = build({ ...READY, exceptions: undefined });
    expect(derived.checklist.blockingExceptionsOpen).toBeGreaterThan(0);
    expect(derived.notKnown).toContain('blocking_exceptions_cleared');
  });

  it('never turns absent control totals into a passed QG-07', () => {
    const derived = build({ ...READY, reconciliation: undefined });
    expect(derived.checklist.qg07Passed).toBe(false);
    expect(derived.notKnown).toContain('control_totals_signed');
  });

  it('never turns an unrecorded parallel run into a sufficient one', () => {
    const derived = build({ ...READY, parallel: undefined });
    expect(derived.checklist.parallelRunSufficient).toBe(false);
    expect(derived.notKnown).toContain('parallel_run_sufficient');
  });

  it('tells "nobody is named" apart from "nobody told us who is named"', () => {
    // Both fail. They need different people to fix them, so they are not the same sentence.
    expect(build({ ...READY, namedTeam: [] }).notKnown).not.toContain('team_named');
    expect(build({ ...READY, namedTeam: undefined }).notKnown).toContain('team_named');
  });

  it('says out loud that an unanswerable check is a producer that is not connected', () => {
    expect(build({}).detail).toContain('not connected');
  });
});

// ── Every check says where its answer came from ─────────────────────────────

describe('nobody has to take a tick on trust', () => {
  it('gives every one of the eight a sentence of evidence', () => {
    const derived = build(READY);
    expect(derived.checks).toHaveLength(8);
    for (const check of derived.checks) {
      expect(check.evidence.length, `${check.check} says nothing`).toBeGreaterThan(20);
    }
  });

  it('quotes the producer’s own words rather than composing new ones', () => {
    const derived = build(READY);
    const qg07 = derived.checks.find((c) => c.check === 'control_totals_signed');
    expect(qg07?.evidence).toBe(READY.reconciliation?.detail);
    const parallel = derived.checks.find((c) => c.check === 'parallel_run_sufficient');
    expect(parallel?.evidence).toBe(READY.parallel?.detail);
  });

  it('names who is on the night rather than counting them', () => {
    const team = build(READY).checks.find((c) => c.check === 'team_named');
    expect(team?.evidence).toContain('u-owner');
    expect(team?.evidence).toContain('u-eng');
  });
});

// ── P-01, whichever way it goes ─────────────────────────────────────────────

describe('the shop opens either way', () => {
  it('says so on a GO', () => {
    expect(decide(READY).shopKeepsTrading).toBe(true);
  });

  it('and on a NO GO with nothing known at all', () => {
    expect(decide({}).shopKeepsTrading).toBe(true);
  });
});
