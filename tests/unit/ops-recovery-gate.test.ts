import { describe, it, expect } from 'vitest';
import { recoveryGateReading, passExpiresAt, REHEARSAL_KINDS, REHEARSAL_TARGETS, scoreDrill, type RehearsalKind, type RehearsalRecord } from '../../packages/ops/src/index';

const NOW = '2026-10-23T12:00:00Z';

// QG-08 (roadmap §22): "Backup restore, store recovery, rollback and incident escalation rehearsed." The reading is GO
// only when the LATEST rehearsal of each of the four kinds exists and passed against its fixed §32 target.

const drill = (kind: RehearsalKind | undefined, passed: boolean, drilledAt: string, id = `${kind}-${drilledAt}`): RehearsalRecord => {
  const target = kind === undefined ? REHEARSAL_TARGETS.backup_restore : REHEARSAL_TARGETS[kind];
  const result = scoreDrill({ target, dataLossSeconds: 0, recoverySeconds: passed ? target.rtoSeconds : target.rtoSeconds + 1 });
  return { drillId: id, ...(kind === undefined ? {} : { rehearsal: kind }), result, drilledBy: 'u-it', drilledAt };
};
const allFour = (passed: boolean, at = '2026-10-20T10:00:00Z'): RehearsalRecord[] => REHEARSAL_KINDS.map((k) => drill(k, passed, at));

describe('the QG-08 recovery gate reading', () => {
  it('with nothing recorded, HOLD naming all four as not rehearsed — never GO from silence', () => {
    const r = recoveryGateReading([], NOW);
    expect(r.verdict).toBe('HOLD');
    expect(r.rehearsals.map((x) => x.state)).toEqual(['missing', 'missing', 'missing', 'missing']);
    expect(r.why).toBe('Backup restore: not rehearsed; Store recovery: not rehearsed; Rollback: not rehearsed; Incident escalation: not rehearsed');
  });

  it('GO when the latest of each of the four passed', () => {
    const r = recoveryGateReading(allFour(true), NOW);
    expect(r.verdict).toBe('GO');
    expect(r.rehearsals.every((x) => x.state === 'passed' && x.drilledBy === 'u-it')).toBe(true);
  });

  it('three of four is HOLD, naming the missing one', () => {
    const r = recoveryGateReading(allFour(true).filter((d) => d.rehearsal !== 'incident_escalation'), NOW);
    expect(r.verdict).toBe('HOLD');
    expect(r.why).toBe('Incident escalation: not rehearsed');
  });

  it('the LATEST rehearsal decides: a later failure turns GO to HOLD, a later pass turns it back', () => {
    const base = allFour(true, '2026-10-20T10:00:00Z');
    const failedLater = [...base, drill('rollback', false, '2026-10-21T10:00:00Z')];
    const r = recoveryGateReading(failedLater, NOW);
    expect(r.verdict).toBe('HOLD');
    expect(r.why).toMatch(/^Rollback: failed — took 1801s to recover against an RTO of 1800s$/);
    expect(recoveryGateReading([...failedLater, drill('rollback', true, '2026-10-22T10:00:00Z')], NOW).verdict).toBe('GO');
    // An older pass recorded after a newer failure does not hide the failure.
    expect(recoveryGateReading([...failedLater, drill('rollback', true, '2026-10-19T10:00:00Z', 'late-entry')], NOW).verdict).toBe('HOLD');
  });

  it('a drill with no rehearsal kind is kept but does not count', () => {
    const r = recoveryGateReading([drill(undefined, true, '2026-10-20T10:00:00Z')], NOW);
    expect(r).toMatchObject({ verdict: 'HOLD', unclassifiedDrills: 1 });
  });

  it('a pass counts for one quarter (OB-332): three calendar months on it reads "not proven" and the gate is HOLD again', () => {
    const july = allFour(true, '2026-07-23T12:00:00Z');
    // A moment before the quarter is up: still GO.
    expect(recoveryGateReading(july, '2026-10-23T11:59:59Z').verdict).toBe('GO');
    // The quarter is up: every rehearsal reads not proven, the gate is HOLD, and it says when each ran out.
    const r = recoveryGateReading(july, NOW);
    expect(r.verdict).toBe('HOLD');
    expect(r.rehearsals.map((x) => x.state)).toEqual(['expired', 'expired', 'expired', 'expired']);
    expect(r.rehearsals[0]).toMatchObject({ passExpiresAt: '2026-10-23T12:00:00.000Z' });
    expect(r.why).toContain('Backup restore: not proven — it passed on 2026-07-23, and a pass counts for one quarter (it ran out on 2026-10-23); rehearse it again');
    // One rehearsed again this quarter is proven; the other three still are not.
    const again = recoveryGateReading([...july, drill('rollback', true, '2026-10-01T09:00:00Z')], NOW);
    expect(again.rehearsals.map((x) => [x.kind, x.state])).toEqual([['backup_restore', 'expired'], ['store_recovery', 'expired'], ['rollback', 'passed'], ['incident_escalation', 'expired']]);
    // A failure is a failure however old; the quarter is calendar months, clamped to the month's end.
    expect(recoveryGateReading([drill('rollback', false, '2026-01-01T00:00:00Z')], NOW).rehearsals[2]?.state).toBe('failed');
    expect(passExpiresAt('2026-11-30T08:00:00Z')).toBe('2027-02-28T08:00:00.000Z');
    expect(passExpiresAt('2026-01-31T00:00:00Z')).toBe('2026-04-30T00:00:00.000Z');
  });

  it('each kind has its fixed §32 target', () => {
    expect(REHEARSAL_TARGETS.backup_restore).toMatchObject({ rpoSeconds: 900, rtoSeconds: 14_400 });
    expect(REHEARSAL_TARGETS.store_recovery).toMatchObject({ rpoSeconds: 0, rtoSeconds: 1_800 });
    expect(REHEARSAL_TARGETS.rollback).toMatchObject({ rpoSeconds: 0, rtoSeconds: 1_800 });
    expect(REHEARSAL_TARGETS.incident_escalation).toMatchObject({ rpoSeconds: 0, rtoSeconds: 900 });
  });
});
