// The QG-08 recovery gate reading (roadmap §22 QG-08, §32; OB-288 gates lane).
//
// §22 QG-08 Recovery: "Backup restore, store recovery, rollback and incident escalation rehearsed." Four
// rehearsals, named by the roadmap. This reads the DR-drill register and says, for each of the four, whether the
// LATEST rehearsal of that kind exists and passed — and reads GO only when all four do. A missing rehearsal is
// named as missing; a failed one is named with what it missed. It never reads GO from silence (P-08).
//
// Each kind is scored against a FIXED §32 target, so a rehearsal cannot be recorded against an easier one:
//   • backup restore     — cloud database RPO ≤15 min, RTO ≤4 h            (§32 "Cloud database RPO/RTO")
//   • store recovery     — store-edge RPO 0 for committed sales, RTO ≤30 min (§32 "Store-edge RPO/RTO")
//   • rollback           — the previous release back within 30 min, no committed sale lost
//                          (§32 store-edge service RTO; the timed drill in scripts/lib/rollback-drill.mjs)
//   • incident escalation — a critical alert acknowledged within 15 min      (§32 "Critical alert acknowledgement
//                          ≤15 min"); an escalation drill loses no data, so its RPO is 0.
//
// This is EVIDENCE for the gate, not the gate decision: the owner still decides QG-08 GO / HOLD / REWORK on the
// gate register (QG-12). Pure, no clock, no I/O.

import type { RecoveryTarget, DrillResult } from './backup';

export type RehearsalKind = 'backup_restore' | 'store_recovery' | 'rollback' | 'incident_escalation';
export const REHEARSAL_KINDS: readonly RehearsalKind[] = Object.freeze(['backup_restore', 'store_recovery', 'rollback', 'incident_escalation']);

/** The fixed §32 target each rehearsal kind is scored against. */
export const REHEARSAL_TARGETS: Readonly<Record<RehearsalKind, RecoveryTarget>> = Object.freeze({
  backup_restore: { service: 'backup restore (cloud database)', rpoSeconds: 900, rtoSeconds: 14_400 },
  store_recovery: { service: 'store recovery (store-edge committed sales)', rpoSeconds: 0, rtoSeconds: 1_800 },
  rollback: { service: 'rollback (previous release back)', rpoSeconds: 0, rtoSeconds: 1_800 },
  incident_escalation: { service: 'incident escalation (critical alert acknowledged)', rpoSeconds: 0, rtoSeconds: 900 },
});

export const REHEARSAL_WORDS: Readonly<Record<RehearsalKind, string>> = Object.freeze({
  backup_restore: 'Backup restore', store_recovery: 'Store recovery', rollback: 'Rollback', incident_escalation: 'Incident escalation',
});

/** A recorded drill as the gate reads it. */
export interface RehearsalRecord {
  readonly drillId: string;
  readonly rehearsal?: RehearsalKind;
  readonly result: DrillResult;
  readonly drilledBy: string;
  readonly drilledAt: string;
}

export interface RehearsalReading {
  readonly kind: RehearsalKind;
  readonly words: string;
  readonly state: 'passed' | 'failed' | 'missing';
  readonly drillId?: string;
  readonly drilledAt?: string;
  readonly drilledBy?: string;
  readonly detail: string;
}

export interface RecoveryGateReading {
  readonly gate: 'QG-08';
  readonly verdict: 'GO' | 'HOLD';
  readonly rehearsals: readonly RehearsalReading[];
  /** Drills recorded without a rehearsal kind — kept on the register, but they do not count for the gate. */
  readonly unclassifiedDrills: number;
  readonly why: string;
}

/** The latest rehearsal of each kind decides; GO only when all four exist and passed. */
export function recoveryGateReading(drills: readonly RehearsalRecord[]): RecoveryGateReading {
  const latest = new Map<RehearsalKind, RehearsalRecord>();
  let unclassified = 0;
  for (const d of drills) {
    if (d.rehearsal === undefined || !REHEARSAL_KINDS.includes(d.rehearsal)) { unclassified += 1; continue; }
    const prior = latest.get(d.rehearsal);
    if (prior === undefined || d.drilledAt >= prior.drilledAt) latest.set(d.rehearsal, d);
  }
  const rehearsals = REHEARSAL_KINDS.map((kind): RehearsalReading => {
    const d = latest.get(kind);
    if (d === undefined) return { kind, words: REHEARSAL_WORDS[kind], state: 'missing', detail: `no ${REHEARSAL_WORDS[kind].toLowerCase()} rehearsal has been recorded` };
    return {
      kind, words: REHEARSAL_WORDS[kind], state: d.result.passed ? 'passed' : 'failed',
      drillId: d.drillId, drilledAt: d.drilledAt, drilledBy: d.drilledBy, detail: d.result.detail,
    };
  });
  const notPassed = rehearsals.filter((r) => r.state !== 'passed');
  return {
    gate: 'QG-08',
    verdict: notPassed.length === 0 ? 'GO' : 'HOLD',
    rehearsals,
    unclassifiedDrills: unclassified,
    why: notPassed.length === 0
      ? 'the latest backup restore, store recovery, rollback and incident escalation rehearsals all passed'
      : notPassed.map((r) => `${r.words}: ${r.state === 'missing' ? 'not rehearsed' : `failed — ${r.detail}`}`).join('; '),
  };
}
