import { describe, it, expect } from 'vitest';
import { compareParallelDay, ownDifference, type DayComparison, type ParallelDifference } from '../../packages/migration/src/cutover';
import { dayDigestOf, signParallelDay, signatureStillApplies, unexplainedDifferences } from '../../packages/migration/src/parallel-day-sign';
import { createMigrationSession, type MigrationPorts } from '../../apps/web-erp/src/migration-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * MG-10 — a parallel-run day is SIGNED by the named reconciler (or the owner), and never while a material difference
 * (beyond the day's tolerance) has no reason. The screen enters the day (both systems' totals, typed or imported), names
 * every difference, and queues both acts for the cloud. Synthetic data only.
 */

const DAY = '2026-10-10';
const C: DayComparison[] = [
  { area: 'sales_value', legacyValue: 10_000_000, newValue: 10_000_000, toleranceMinor: 0 },
  { area: 'payments', legacyValue: 10_000_000, newValue: 9_950_000, toleranceMinor: 100 },
  { area: 'sales_count', legacyValue: 412, newValue: 412, toleranceMinor: 0 },
];
const raised = (): ParallelDifference[] => [...compareParallelDay({ tenantId: 't', businessDate: DAY, comparisons: C }).differences];
const base = { businessDate: DAY, comparisons: C, signedBy: 'u-recon', statement: 'compared the old day-end report with the new day book, area by area', now: '2026-10-11T08:00:00.000Z', reconcilerUserId: 'u-recon', ownerUserId: 'u-owner' };

describe('signParallelDay', () => {
  it('a material difference with no reason stops the signature, and the refusal names it', () => {
    const r = signParallelDay({ ...base, differences: raised() });
    expect(r).toMatchObject({ ok: false, refusedBecause: 'unexplained_material_difference' });
    if (!r.ok) {
      expect(r.unexplained.map((d) => d.differenceId)).toEqual(['PD-2026-10-10-001']);
      expect(r.detail).toMatch(/payments, -50000/);
    }
  });

  it('a difference within tolerance is not material and never stops a day', () => {
    const within: DayComparison[] = [{ area: 'payments', legacyValue: 1000, newValue: 999, toleranceMinor: 1 }];
    expect(signParallelDay({ ...base, comparisons: within, differences: compareParallelDay({ tenantId: 't', businessDate: DAY, comparisons: within }).differences })).toMatchObject({ ok: true });
  });

  it('owned is not explained; a reason that says nothing is not a reason', () => {
    const owned = ownDifference({ differences: raised(), differenceId: 'PD-2026-10-10-001', ownerUserId: 'u-recon' }).differences;
    expect(signParallelDay({ ...base, differences: owned })).toMatchObject({ ok: false, refusedBecause: 'unexplained_material_difference' });
    const weak = ownDifference({ differences: raised(), differenceId: 'PD-2026-10-10-001', ownerUserId: 'u-recon', explanation: 'ok' }).differences;
    expect(unexplainedDifferences(DAY, weak)).toHaveLength(1);
    expect(signParallelDay({ ...base, differences: weak })).toMatchObject({ ok: false, refusedBecause: 'unexplained_material_difference' });
  });

  it('explained → signed, with each difference and its reason carried on the signature', () => {
    const explained = ownDifference({ differences: raised(), differenceId: 'PD-2026-10-10-001', ownerUserId: 'u-recon', explanation: 'a UPI refund of 500 keyed only in the old system', wrongSide: 'legacy' }).differences;
    const r = signParallelDay({ ...base, differences: explained });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signature).toMatchObject({ businessDate: DAY, signedBy: 'u-recon', dayDigest: dayDigestOf(C) });
      expect(r.signature.differences).toEqual([expect.objectContaining({ differenceId: 'PD-2026-10-10-001', wrongSide: 'legacy', ownerUserId: 'u-recon' })]);
    }
    // The owner may sign too; anybody else may not.
    expect(signParallelDay({ ...base, signedBy: 'u-owner', differences: explained })).toMatchObject({ ok: true });
    expect(signParallelDay({ ...base, signedBy: 'u-cashier', differences: explained })).toMatchObject({ ok: false, refusedBecause: 'not_the_named_reconciler' });
  });

  it('refuses a nameless signer, an unrecorded day and an empty statement', () => {
    expect(signParallelDay({ ...base, signedBy: ' ', differences: [] })).toMatchObject({ ok: false, refusedBecause: 'nobody_named' });
    expect(signParallelDay({ ...base, comparisons: undefined, differences: [] })).toMatchObject({ ok: false, refusedBecause: 'day_not_recorded' });
    const clean: DayComparison[] = [C[0]!];
    expect(signParallelDay({ ...base, comparisons: clean, statement: 'ok', differences: [] })).toMatchObject({ ok: false, refusedBecause: 'statement_says_nothing' });
  });

  it('a signature belongs to the figures it saw: a day recorded again with other figures is unsigned', () => {
    const r = signParallelDay({ ...base, comparisons: [C[0]!], differences: [] });
    if (!r.ok) throw new Error(r.detail);
    expect(signatureStillApplies(r.signature, [C[0]!])).toBe(true);
    expect(signatureStillApplies(r.signature, [{ ...C[0]!, newValue: 1 }])).toBe(false);
    expect(signatureStillApplies(r.signature, undefined)).toBe(false);
    expect(dayDigestOf([C[0]!, C[2]!])).toBe(dayDigestOf([C[2]!, C[0]!])); // order does not matter
  });
});

describe('the migration screen enters, explains and signs a day — local first, then queued', () => {
  const ports = (outbox: SyncOutbox): MigrationPorts => ({
    sources: () => undefined, exceptions: () => undefined, totals: () => undefined,
    parallelDays: () => [], parallelDifferences: () => [], exclusions: () => undefined, archive: () => undefined,
    edgeUnsyncedItems: () => 0, deltaAppliedAt: () => undefined, rollbackDemonstratedAt: () => undefined,
    namedTeam: () => undefined, ownerGoBy: () => undefined, openAssessments: () => undefined, outbox: () => outbox,
    daySignatures: () => [], verification: () => ({ covered: ['stock'], missing: ['bank'] }),
  });
  const make = (userId: string | null, reconciler: string | null = 'u-recon') => {
    const outbox = new SyncOutbox();
    const s = createMigrationSession({
      tenantId: 't', userId, now: '2026-10-11T08:00:00.000Z', cutoverId: 'CUT-1', requiredCleanDays: 3, loadOperator: 'u-loader', cutoverAccepted: false,
      ...(reconciler === null ? {} : { dailyReconcilerUserId: reconciler }),
    }, ports(outbox));
    return { s, outbox };
  };
  const lines = (why?: string) => C.map((c) => ({ ...c, ...(c.area === 'payments' && why !== undefined ? { explanation: why, wrongSide: 'legacy' as const } : {}) }));

  it('the reconciler enters a day: each difference is named, the one without a reason stops the signature, nothing signed is queued', () => {
    const { s, outbox } = make('u-recon');
    const entered = s.enterDay({ businessDate: DAY, lines: lines() });
    expect(entered.ok).toBe(true);
    expect(s.day(DAY).differences.map((d) => [d.differenceId, d.area])).toEqual([['PD-2026-10-10-001', 'payments']]);
    expect(s.day(DAY).unexplained).toHaveLength(1);
    const refused = s.signDay({ businessDate: DAY, statement: 'compared the old day-end report with the new day book' });
    expect(refused).toMatchObject({ ok: false, refusal: 'unexplained_material_difference' });
    expect(outbox.pending().map((e) => e.event.type)).toEqual(['MigrationParallelDayEntered']);
    // The parallel-run position sees the day at once (a bad day).
    expect(s.parallel()).toMatchObject({ daysRun: 1, consecutiveCleanDays: 0 });
  });

  it('with the reason, the day is signed; both acts are queued with the reconciler\'s name and the figures\' digest', () => {
    const { s, outbox } = make('u-recon');
    s.enterDay({ businessDate: DAY, lines: lines() });
    expect(s.enterDay({ businessDate: DAY, lines: lines('a UPI refund of 500 keyed only in the old system') }).ok).toBe(true);
    expect(s.day(DAY).unexplained).toEqual([]);
    const signed = s.signDay({ businessDate: DAY, statement: 'compared the old day-end report with the new day book' });
    expect(signed).toMatchObject({ ok: true, signature: { signedBy: 'u-recon', dayDigest: dayDigestOf(C) } });
    expect(s.day(DAY).signature?.signedBy).toBe('u-recon');
    const queued = outbox.pending().map((e) => ({ type: e.event.type, payload: e.event.payload as Record<string, unknown> }));
    expect(queued.map((q) => q.type)).toEqual(['MigrationParallelDayEntered', 'MigrationParallelDayEntered', 'MigrationParallelDaySigned']);
    expect(queued[1]!.payload).toMatchObject({ businessDate: DAY, enteredBy: 'u-recon', explanations: [{ area: 'payments', wrongSide: 'legacy' }] });
    expect(queued[2]!.payload).toMatchObject({ businessDate: DAY, signedBy: 'u-recon', dayDigest: dayDigestOf(C) });
    // New figures for the same day make it a different day: unsigned again, its differences raised afresh.
    s.enterDay({ businessDate: DAY, lines: C.map((c) => (c.area === 'sales_count' ? { ...c, newValue: 411 } : c)) });
    expect(s.day(DAY).signature).toBeUndefined();
    expect(s.day(DAY).unexplained.map((d) => d.area).sort()).toEqual(['payments', 'sales_count']);
  });

  it('refuses nobody named at the desk, nobody named to reconcile, somebody else, no date, and a blank figure — nothing queued', () => {
    for (const [userId, reconciler, refusal] of [[null, 'u-recon', 'nobody_is_named_at_this_desk'], ['u-recon', null, 'nobody_named_to_reconcile'], ['u-cashier', 'u-recon', 'not_the_named_reconciler']] as const) {
      const { s, outbox } = make(userId, reconciler);
      expect(s.enterDay({ businessDate: DAY, lines: lines() })).toMatchObject({ ok: false, refusal });
      expect(outbox.pending()).toEqual([]);
    }
    const { s, outbox } = make('u-recon');
    expect(s.enterDay({ businessDate: '10/10/2026', lines: lines() })).toMatchObject({ ok: false, refusal: 'not_a_date' });
    expect(s.enterDay({ businessDate: DAY, lines: [{ ...C[0]!, legacyValue: Number.NaN }] })).toMatchObject({ ok: false, refusal: 'no_figures' });
    expect(s.enterDay({ businessDate: DAY, lines: lines('the new system is probably right') })).toMatchObject({ ok: false, refusal: 'explanation_refused' });
    expect(outbox.pending()).toEqual([]);
  });

  it('carries the witness position and the four templates', () => {
    const { s } = make('u-recon');
    expect(s.witness()).toEqual({ covered: ['stock'], missing: ['bank'] });
    expect(s.sliceTemplates().map((t) => t.file)).toEqual(['tax-classes.csv', 'products.csv', 'prices.csv', 'barcodes.csv']);
  });
});
