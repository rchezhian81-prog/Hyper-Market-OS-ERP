import { describe, it, expect } from 'vitest';
import {
  assertNonProduction, runTrialLoad, applyDelta,
  type DeltaChange, type LoadTarget, type TrialLoadPlan,
} from '../../packages/migration/src/trial';

// MG-05 / MG-09 — full volume, repeatable, non-production (hard rule #7), applied exactly once.

const target = (over: Partial<LoadTarget> = {}): LoadTarget => ({
  targetId: 'tgt-1', tenantId: 't-sre', kind: 'rehearsal', label: 'migration rehearsal', ...over,
});

const plan = (over: Partial<TrialLoadPlan> = {}): TrialLoadPlan => ({
  trialId: 'trial-1', tenantId: 't-sre', target: target(), rowsToLoad: 41_200,
  operator: 'u-operator', extractVerified: true, blockingExceptionsOpen: 0,
  targetPreparedEmpty: true, ...over,
});

describe('hard rule #7 is absolute, and it is its own callable check', () => {
  it('permits a rehearsal, a staging and a local target', () => {
    for (const kind of ['rehearsal', 'staging', 'local'] as const) {
      expect(assertNonProduction(target({ kind })).permitted).toBe(true);
    }
  });

  it('REFUSES production, and names the realistic accident', () => {
    const r = assertNonProduction(target({ kind: 'production', label: 'sre-prod' }));
    expect(r.permitted).toBe(false);
    expect(r.detail).toContain('a copied connection string at eleven at night');
  });

  it('decides on the KIND, never on the label — a reassuring name is not evidence', () => {
    const disguised = target({ kind: 'production', label: 'staging-copy-safe-to-load' });
    expect(assertNonProduction(disguised).permitted).toBe(false);
  });

  it('refuses a production target BEFORE any other check, even a missing operator', () => {
    // Every other refusal costs an evening. This one costs the shop, so it runs first.
    const r = runTrialLoad({
      plan: plan({ target: target({ kind: 'production' }), operator: '', extractVerified: false, targetPreparedEmpty: false }),
      elapsedMs: 1_000,
    });
    expect(r.refusedBecause).toBe('production_target');
  });

  it('refuses a delta against production, and applies none of it', () => {
    const r = applyDelta({
      target: target({ kind: 'production' }),
      changes: [{ changeKey: 'k1', entity: 'stock', legacyId: 'P1', operation: 'update', changedAt: '2026-08-06T10:00:00Z' }],
      extractCutoff: '2026-08-05T00:00:00Z',
    });
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(r.lines[0]?.outcome).toBe('refused_production');
  });
});

describe('a trial load rehearses the volume and the clock, or it rehearses nothing', () => {
  it('loads and reports the projected full-volume time', () => {
    const r = runTrialLoad({ plan: plan({ rowsToLoad: 41_200 }), elapsedMs: 82_400, fullVolumeRows: 941_200 });
    expect(r.ok).toBe(true);
    expect(r.rowsLoaded).toBe(41_200);
    expect(r.projectedFullVolumeMs).toBe(1_882_400);
    expect(r.repeatable).toBe(true);
    expect(r.detail).toContain('the cutover window is a real evening');
  });

  it('refuses a load whose target was not prepared empty — it would work exactly once', () => {
    const r = runTrialLoad({ plan: plan({ targetPreparedEmpty: false }), elapsedMs: 1_000 });
    expect(r.refusedBecause).toBe('target_not_empty');
    expect(r.detail).toContain('it is the cutover');
  });

  it('refuses an unverified extract and an unnamed operator', () => {
    expect(runTrialLoad({ plan: plan({ extractVerified: false }), elapsedMs: 1 }).refusedBecause).toBe('extract_not_verified');
    expect(runTrialLoad({ plan: plan({ operator: '  ' }), elapsedMs: 1 }).refusedBecause).toBe('no_operator');
  });

  it('refuses while blocking exceptions are open — it would rehearse the wrong data', () => {
    const r = runTrialLoad({ plan: plan({ blockingExceptionsOpen: 22 }), elapsedMs: 1 });
    expect(r.refusedBecause).toBe('blocking_exceptions_open');
    expect(r.detail).toContain('reconciles to the wrong totals');
  });
});

describe('a delta applies exactly once (§31.1)', () => {
  const change = (over: Partial<DeltaChange> = {}): DeltaChange => ({
    changeKey: 'k1', entity: 'stock', legacyId: 'P00001', operation: 'update',
    changedAt: '2026-08-06T10:00:00Z', deltaQty: 5, deltaMinor: 12_500, ...over,
  });
  const cutoff = '2026-08-05T22:00:00Z';

  it('applies new changes and totals the movement', () => {
    const r = applyDelta({
      target: target(),
      changes: [change(), change({ changeKey: 'k2', deltaQty: -2, deltaMinor: -5_000 })],
      extractCutoff: cutoff,
    });
    expect(r.applied).toBe(2);
    expect(r.netQty).toBe(3);
    expect(r.netValueMinor).toBe(7_500);
  });

  it('treats a re-sent change as a SUCCESS, not an error', () => {
    const first = applyDelta({ target: target(), changes: [change(), change({ changeKey: 'k2' })], extractCutoff: cutoff });
    const second = applyDelta({
      target: target(), changes: [change(), change({ changeKey: 'k2' }), change({ changeKey: 'k3' })],
      extractCutoff: cutoff, alreadyApplied: first.appliedKeys,
    });
    expect(second.ok).toBe(true);
    expect(second.duplicatesIgnored).toBe(2);
    expect(second.applied).toBe(1);
    expect(second.lines[0]?.detail).toContain('cannot be resumed at midnight');
  });

  it('does not double-count when the whole delta is replayed', () => {
    const changes = [change(), change({ changeKey: 'k2', deltaQty: 7, deltaMinor: 3_000 })];
    const first = applyDelta({ target: target(), changes, extractCutoff: cutoff });
    const replay = applyDelta({ target: target(), changes, extractCutoff: cutoff, alreadyApplied: first.appliedKeys });
    expect(replay.netQty).toBe(0);
    expect(replay.netValueMinor).toBe(0);
    expect(replay.appliedKeys).toEqual(first.appliedKeys);
  });

  it('REFUSES a change dated before the extract cutoff — it is already loaded', () => {
    const r = applyDelta({
      target: target(),
      changes: [change({ changeKey: 'old', changedAt: '2026-08-01T09:00:00Z' })],
      extractCutoff: cutoff,
    });
    expect(r.refused).toBe(1);
    expect(r.applied).toBe(0);
    expect(r.lines[0]?.outcome).toBe('refused_before_cutoff');
    expect(r.lines[0]?.detail).toContain('the double-count MG-09 exists to prevent');
  });

  it('carries applied keys forward so an interrupted run is resumable', () => {
    const partial = applyDelta({ target: target(), changes: [change(), change({ changeKey: 'k2' })], extractCutoff: cutoff });
    expect(partial.appliedKeys).toEqual(['k1', 'k2']);
    const resumed = applyDelta({
      target: target(), changes: [change({ changeKey: 'k2' }), change({ changeKey: 'k3' })],
      extractCutoff: cutoff, alreadyApplied: partial.appliedKeys,
    });
    expect(resumed.appliedKeys).toEqual(['k1', 'k2', 'k3']);
  });
});
