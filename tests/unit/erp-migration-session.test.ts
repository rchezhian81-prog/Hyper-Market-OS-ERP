import { describe, it, expect } from 'vitest';
import {
  createMigrationSession,
  SIGN_REFUSAL_KINDS, RESOLVE_REFUSAL_KINDS, ROLLBACK_REFUSAL_KINDS,
  type MigrationConfig, type MigrationPorts,
} from '../../apps/web-erp/src/migration-session';
import type {
  ControlTotal, HistoryExclusion, LegacyArchive, LegacySource, MigrationException,
  ParallelDayResult, ParallelDifference,
} from '../../packages/migration/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **Migration (MG-01…MG-12 · §34 · §34.1 · WF-19 · QG-07 · OD-05 · OD-06).**
 *
 * The design bar is one line: *no cutover without signed control totals, every exception kept,
 * and a rollback that has been performed rather than designed.*
 *
 * The controls under test are the ones nothing outside their own tests had ever reached:
 *
 *   • **the eight-check gate is DERIVED**, from the same producers the pipeline uses, and an
 *     unanswerable check fails rather than defaulting to a comfortable pass;
 *   • **an exception is resolved, never removed** (hard rule #6), and a resolved one stays on the
 *     list because it is the evidence somebody looked at it;
 *   • **the person who ran the load cannot sign its totals** (§28) — and a box that was never told
 *     who ran it cannot sign anything at all;
 *   • **the rollback needs nobody's approval**, at any time, in any state;
 *   • and absence is never nought: no discovery, no totals, no parallel run and no archive each
 *     say so rather than reading as clean.
 */

const NOW = '2026-09-11T02:00:00.000Z';

const source = (over: Partial<LegacySource> = {}): LegacySource => ({
  sourceId: 'S-1', tenantId: 't-sre', name: 'Legacy ERP database', kind: 'erp_database',
  ownerUserId: 'u-owner', rowCount: 41_200, volumeBasis: 'counted', retentionYears: 8,
  extractable: true,
  ...over,
});

const exception = (over: Partial<MigrationException> = {}): MigrationException => ({
  exceptionId: 'EX-1', tenantId: 't-sre', kind: 'negative_stock', severity: 'blocking',
  confidence: 'certain', legacyIds: ['p-9'], evidence: 'stock on hand is -4 for toor dal 1kg',
  valueMinor: 40_000,
  ...over,
});

const total = (over: Partial<ControlTotal> = {}): ControlTotal => ({
  totalId: 'CT-1', tenantId: 't-sre', kind: 'migration', name: 'Product rows',
  unit: 'rows', legacyValue: 41_200, loadedValue: 41_200,
  legacyDerivation: 'count(*) on the legacy product table',
  loadedDerivation: 'count(*) on the loaded product table',
  ...over,
});

const signed = (over: Partial<ControlTotal> = {}): ControlTotal => total({
  signature: {
    signedBy: 'u-owner', signerRole: 'owner', signedAt: '2026-09-01T11:00:00.000Z',
    statement: 'I have checked the product row count against the printed report',
  },
  ...over,
});

const cleanDay = (businessDate: string): ParallelDayResult => ({
  tenantId: 't-sre', businessDate, differences: [], clean: true,
  totalDifferenceMinor: 0, detail: 'both systems agree',
});

const difference = (over: Partial<ParallelDifference> = {}): ParallelDifference => ({
  differenceId: 'PD-1', tenantId: 't-sre', businessDate: '2026-09-05',
  area: 'sales_value', difference: 4_500, status: 'open',
  ...over,
});

const exclusion = (over: Partial<HistoryExclusion> = {}): HistoryExclusion => ({
  exclusionId: 'HX-1', tenantId: 't-sre', scope: 'documents_before',
  boundary: '2019-04-01', reason: 'the tax regime changed and these documents cannot be re-rated',
  recordsExcluded: 12_400, valueMinor: 0, proposedBy: 'u-eng', status: 'proposed',
  ...over,
} as HistoryExclusion);

const archive = (over: Partial<LegacyArchive> = {}): LegacyArchive => ({
  archiveId: 'AR-1', tenantId: 't-sre', sourceId: 'S-1', digest: 'abc123', rowCount: 41_200,
  archivedAt: '2026-09-11T00:00:00.000Z', retentionYears: 8,
  earliestRecordDate: '2014-04-01', latestRecordDate: '2026-09-10', readOnly: true,
  ...over,
});

const CONFIG: MigrationConfig = {
  tenantId: 't-sre', userId: 'u-owner', now: NOW, cutoverId: 'cut-1',
  requiredCleanDays: 3, loadOperator: 'u-eng', cutoverAccepted: false,
};

/** A migration that is ready in every way. Anything less must not reach GO. */
function ports(over: Partial<MigrationPorts> = {}): MigrationPorts {
  return {
    sources: () => [source()],
    exceptions: () => [exception({ resolution: {
      action: 'correct', decidedBy: 'u-manager', decidedAt: '2026-09-02T09:00:00.000Z',
      reason: 'counted the shelf and set it to 4',
    } })],
    totals: () => [signed()],
    parallelDays: () => [cleanDay('2026-09-01'), cleanDay('2026-09-02'), cleanDay('2026-09-03')],
    parallelDifferences: () => [],
    exclusions: () => [],
    archive: () => archive(),
    edgeUnsyncedItems: () => 0,
    deltaAppliedAt: () => '2026-09-10T21:00:00.000Z',
    rollbackDemonstratedAt: () => '2026-09-08T22:00:00.000Z',
    namedTeam: () => [{ userId: 'u-owner', role: 'decision' }, { userId: 'u-eng', role: 'load' }],
    ownerGoBy: () => 'u-owner',
    openAssessments: () => 0,
    outbox: () => outbox,
    ...over,
  };
}

/** A fresh queue per session, so a test can ask what a decision actually enqueued. */
let outbox: SyncOutbox;

const migration = (over: Partial<MigrationPorts> = {}, config: Partial<MigrationConfig> = {}) => {
  outbox = new SyncOutbox();
  return createMigrationSession({ ...CONFIG, ...config }, ports(over));
};

// ── The gate that had only ever been told ───────────────────────────────────

describe('the eight checks are derived from the real state, never asserted', () => {
  it('reaches GO when every one of the eight is answered and good', () => {
    const view = migration().cutover();
    expect(view.decision.go, view.decision.detail).toBe(true);
    expect(view.derived.notKnown).toEqual([]);
  });

  it('takes QG-07 from the signatures on the totals', () => {
    const view = migration({ totals: () => [total()] }).cutover();
    expect(view.decision.go).toBe(false);
    expect(view.decision.failed).toContain('control_totals_signed');
  });

  it('takes the unsynced count from the store box, and NEVER defaults it', () => {
    // The most dangerous default available here. An unsynced till is an unmigrated sale, and it
    // is not found until a customer asks for the receipt.
    const view = migration({ edgeUnsyncedItems: () => undefined }).cutover();
    expect(view.decision.failed).toContain('edge_fully_synced');
    expect(view.derived.notKnown).toContain('edge_fully_synced');
  });

  it('fails, rather than passes, when it knows nothing at all', () => {
    const blank = migration({
      sources: () => undefined, exceptions: () => undefined, totals: () => undefined,
      parallelDays: () => undefined, parallelDifferences: () => undefined,
      exclusions: () => undefined, archive: () => undefined,
      edgeUnsyncedItems: () => undefined, deltaAppliedAt: () => undefined,
      rollbackDemonstratedAt: () => undefined, namedTeam: () => undefined,
      ownerGoBy: () => undefined, openAssessments: () => undefined,
    }).cutover();
    expect(blank.decision.go).toBe(false);
    expect(blank.decision.failed).toHaveLength(8);
    expect(blank.derived.notKnown.length).toBeGreaterThan(0);
  });

  it('says where every answer came from, so nobody takes a tick on trust', () => {
    for (const check of migration().cutover().derived.checks) {
      expect(check.evidence.length, `${check.check} says nothing`).toBeGreaterThan(20);
    }
  });

  it('the shop keeps trading whichever way it goes', () => {
    expect(migration().cutover().decision.shopKeepsTrading).toBe(true);
    expect(migration({ ownerGoBy: () => undefined }).cutover().decision.shopKeepsTrading).toBe(true);
  });
});

// ── Absence is never nought ─────────────────────────────────────────────────

describe('what nobody has told this screen is never reported as clean', () => {
  it('has no discovery at all rather than an empty inventory', () => {
    // Discovery that never ran and discovery that found nothing are opposite facts, and only
    // one of them is possible in a shop that has been trading for years.
    expect(migration({ sources: () => undefined }).discovery()).toBeUndefined();
    expect(migration().discovery()?.sources).toHaveLength(1);
  });

  it('names every gap in the inventory, because the gaps are the output', () => {
    const result = migration({
      sources: () => [source({ ownerUserId: undefined, volumeBasis: 'estimated', retentionYears: undefined })],
    }).discovery();
    expect(result?.complete).toBe(false);
    expect(result?.gaps.map((g) => g.kind).sort())
      .toEqual(['no_named_owner', 'no_retention_period', 'volume_estimated']);
  });

  it('has no reconciliation at all rather than one with nothing wrong', () => {
    expect(migration({ totals: () => undefined }).reconciliation()).toBeUndefined();
  });

  it('has no parallel position without BOTH the days and the differences', () => {
    // Days alone would report every day clean; differences alone would report no run at all.
    expect(migration({ parallelDays: () => undefined }).parallel()).toBeUndefined();
    expect(migration({ parallelDifferences: () => undefined }).parallel()).toBeUndefined();
    expect(migration().parallel()?.sufficient).toBe(true);
  });

  it('has no cleaning position rather than a clean one', () => {
    expect(migration({ exceptions: () => undefined }).cleaning()).toBeUndefined();
  });

  it('will not assess retirement on an open-assessment count nobody supplied', () => {
    // Retiring the legacy system on a number nobody gave is the one MG-12 mistake nobody can undo.
    expect(migration({ openAssessments: () => undefined }).retirement()).toBeUndefined();
    expect(migration({ archive: () => undefined }).retirement()).toBeUndefined();
  });
});

// ── Nothing is ever deleted ─────────────────────────────────────────────────

describe('an exception is resolved, never removed (hard rule #6)', () => {
  it('keeps a resolved exception on the list as the evidence somebody looked at it', () => {
    const list = migration().exceptionList();
    expect(list).toHaveLength(1);
    expect(list?.[0]?.resolution?.action).toBe('correct');
  });

  it('puts the undecided ones first, worst first — that is the working queue', () => {
    const list = migration({
      exceptions: () => [
        exception({ exceptionId: 'EX-done', severity: 'blocking', resolution: {
          action: 'correct', decidedBy: 'u', decidedAt: NOW, reason: 'fixed',
        } }),
        exception({ exceptionId: 'EX-low', severity: 'low' }),
        exception({ exceptionId: 'EX-block', severity: 'blocking' }),
      ],
    }).exceptionList();
    expect(list?.map((e) => e.exceptionId)).toEqual(['EX-block', 'EX-low', 'EX-done']);
  });

  it('records a decision against an exception, in the name of whoever made it, and QUEUES it', () => {
    const session = migration({ exceptions: () => [exception()] });
    const outcome = session
      .resolve({ exceptionId: 'EX-1', action: 'migrate_as_is', reason: 'the supplier confirmed the write-off in July' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.exceptions[0]?.resolution?.decidedBy).toBe('u-owner');
    // Still there. The list only ever grows.
    expect(outcome.exceptions).toHaveLength(1);
    // Held for the screen AND queued for the cloud.
    expect(session.exceptionList()?.[0]?.resolution?.decidedBy).toBe('u-owner');
    expect(session.unsent()).toBe(1);
    expect(outbox.pending()[0]?.event.type).toBe('MigrationExceptionResolved');
  });

  it('refuses a decision with no reason — the reason is what anybody reads a year later', () => {
    const outcome = migration({ exceptions: () => [exception()] })
      .resolve({ exceptionId: 'EX-1', action: 'exclude', reason: '   ' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_a_reason');
  });

  it('refuses a merge that does not say which record survives', () => {
    const outcome = migration({ exceptions: () => [exception({ kind: 'duplicate_product', legacyIds: ['p-1', 'p-2'] })] })
      .resolve({ exceptionId: 'EX-1', action: 'merge', reason: 'the same tin under two codes' });
    expect(outcome.ok).toBe(false);
  });

  it('refuses a second decision — the first one is the evidence', () => {
    const outcome = migration().resolve({ exceptionId: 'EX-1', action: 'exclude', reason: 'changed my mind about this one' });
    expect(outcome.ok).toBe(false);
  });

  it('records nothing under a name nobody holds', () => {
    const outcome = migration({ exceptions: () => [exception()] }, { userId: null })
      .resolve({ exceptionId: 'EX-1', action: 'correct', reason: 'counted the shelf' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
  });
});

// ── The last place a wrong opening balance can be stopped ───────────────────

describe('signing a control total', () => {
  it('signs one that reconciles, by somebody who did not run the load', () => {
    const outcome = migration({ totals: () => [total()] }, { userId: 'u-owner' })
      .sign({ totalId: 'CT-1', signerRole: 'owner', statement: 'checked against the printed report' });
    expect(outcome.ok, outcome.ok ? '' : outcome.detail).toBe(true);
  });

  it('QUEUES the signature rather than dropping it — the fault the real page had', () => {
    // The first version computed the signature, showed it green, and the next render read the
    // payload again and drew it unsigned. Local first, then sync (hard rule #1).
    const session = migration({ totals: () => [total()] }, { userId: 'u-owner' });
    expect(session.reconciliation()?.assessments[0]?.signed).toBe(false);
    session.sign({ totalId: 'CT-1', signerRole: 'owner', statement: 'checked against the printed report' });
    // The working copy the screen draws now shows it signed…
    expect(session.reconciliation()?.assessments[0]?.signed).toBe(true);
    // …and it is on the queue for the cloud, not only in this tab.
    expect(session.unsent()).toBe(1);
    expect(outbox.pending()[0]?.event.type).toBe('MigrationTotalSigned');
  });

  it('refuses the person who ran the load (§28)', () => {
    const outcome = migration({ totals: () => [total()] }, { userId: 'u-eng' })
      .sign({ totalId: 'CT-1', signerRole: 'owner', statement: 'checked it' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail).toContain('ran the load');
  });

  it('refuses to sign at all when nobody knows who ran the load', () => {
    // Not defaulted to a name that could never match. A separation of duties that cannot be
    // checked is not a separation.
    const outcome = migration({ totals: () => [total()] }, { loadOperator: undefined })
      .sign({ totalId: 'CT-1', signerRole: 'owner', statement: 'checked it' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_ran_the_load');
  });

  it('refuses an OPEN total — there is no provisional signature', () => {
    const outcome = migration({ totals: () => [total({ loadedValue: 41_100 })] })
      .sign({ totalId: 'CT-1', signerRole: 'owner', statement: 'close enough' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail).toContain('no provisional signature');
  });

  it('refuses anybody but a chartered accountant on a finance or tax total', () => {
    const outcome = migration({ totals: () => [total({ kind: 'tax', totalId: 'CT-TAX' })] })
      .sign({ totalId: 'CT-TAX', signerRole: 'owner', statement: 'I checked the GST figures myself' });
    expect(outcome.ok).toBe(false);
  });

  it('signs nothing under a name nobody holds', () => {
    const outcome = migration({ totals: () => [total()] }, { userId: null })
      .sign({ totalId: 'CT-1', signerRole: 'owner', statement: 'checked it' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
  });
});

// ── §34.1 — a difference is owned the same day ──────────────────────────────

describe('the parallel run', () => {
  it('reports differences with nobody’s name on them', () => {
    const unowned = migration({
      parallelDifferences: () => [difference(), difference({ differenceId: 'PD-2', ownerUserId: 'u-mgr', status: 'owned' })],
    }).unowned();
    expect(unowned.map((d) => d.differenceId)).toEqual(['PD-1']);
  });

  it('counts clean days CONSECUTIVELY, so a bad day resets the evidence', () => {
    const position = migration({
      parallelDays: () => [
        cleanDay('2026-09-01'),
        { ...cleanDay('2026-09-02'), clean: false, differences: [difference()] },
        cleanDay('2026-09-03'),
      ],
      parallelDifferences: () => [difference()],
    }).parallel();
    expect(position?.consecutiveCleanDays).toBe(1);
    expect(position?.sufficient).toBe(false);
  });
});

// ── The rollback ────────────────────────────────────────────────────────────

describe('rolling back needs nobody’s approval', () => {
  it('performs it on the word of whoever is on the night', () => {
    const outcome = migration().rollback({ trigger: 'control_total_failed', legacySystemAvailable: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.performed).toBe(true);
    expect(outcome.result.decidedBy).toBe('u-owner');
    // Nothing about the migration record is unwound (hard rule #6).
    expect(outcome.result.evidenceRetained).toBe(true);
    expect(outcome.result.shopKeepsTrading).toBe(true);
  });

  it('works even when every check has passed and the cutover is mid-flight', () => {
    // Deliberately not gated on the checklist. The decision gets made at 6am by a tired person.
    expect(migration().cutover().decision.go).toBe(true);
    expect(migration().rollback({ trigger: 'owner_decision', legacySystemAvailable: true }).ok).toBe(true);
  });

  it('says out loud when the legacy system is NOT there to take the shop back', () => {
    const outcome = migration().rollback({ trigger: 'data_corruption', legacySystemAvailable: false });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.detail).toContain('NOT available');
  });

  it('rolls back nothing under a name nobody holds', () => {
    const outcome = migration({}, { userId: null })
      .rollback({ trigger: 'owner_decision', legacySystemAvailable: true });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
  });
});

// ── MG-07 and MG-12 ─────────────────────────────────────────────────────────

describe('what is left behind, and what is switched off', () => {
  it('reports exclusions still awaiting the owner — until decided they explain nothing', () => {
    const position = migration({ exclusions: () => [exclusion()] }).exclusions();
    expect(position?.awaitingOwner).toHaveLength(1);
  });

  it('refuses to retire the legacy system while the cutover is not accepted', () => {
    const assessment = migration().retirement();
    expect(assessment?.mayRetireSystem).toBe(false);
    expect(assessment?.blockedBy).toContain('cutover_not_accepted');
    expect(assessment?.blockedBy).toContain('restore_never_verified');
    // And whatever else is true, the data is never deleted.
    expect(assessment?.dataIsNeverDeleted).toBe(true);
  });

  it('names EVERY blocker at once, not the first one found', () => {
    expect(migration().retirement()?.blockedBy.length).toBeGreaterThan(1);
  });
});

// ── The refusal words the screen must be able to say ────────────────────────

describe('the screen can name every refusal it can produce', () => {
  it('lists them all', () => {
    expect(SIGN_REFUSAL_KINDS).toContain('nobody_ran_the_load');
    expect(RESOLVE_REFUSAL_KINDS).toContain('needs_a_reason');
    expect(ROLLBACK_REFUSAL_KINDS).toContain('nobody_is_named_at_this_desk');
    expect(SIGN_REFUSAL_KINDS.length).toBe(3);
  });
});
