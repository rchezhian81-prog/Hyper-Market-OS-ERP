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
// OB-332 (owner, 23 Oct 2026): a PASS is good for ONE QUARTER — three calendar months from the day it was rehearsed. After
// that the rehearsal reads "not proven" (expired) and the gate goes back to HOLD until it is rehearsed again: a restore
// that worked last year proves nothing about this year's backups.
//
// This is EVIDENCE for the gate, not the gate decision: the owner still decides QG-08 GO / HOLD / REWORK on the gate
// register (QG-12). Pure, no I/O: the moment it is read at is passed in.

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
  /** `expired`: it passed, more than one quarter ago — the rehearsal is NOT PROVEN now (OB-332). */
  readonly state: 'passed' | 'failed' | 'missing' | 'expired';
  /** For a pass: the moment it stops counting (three calendar months after it was rehearsed). */
  readonly passExpiresAt?: string;
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

/** OB-332: how long a pass counts — one quarter. */
export const REHEARSAL_PASS_VALID_MONTHS = 3;

/** The moment a pass rehearsed at `at` stops counting: the same moment three calendar months later (clamped to month end). */
export function passExpiresAt(at: string): string {
  const d = new Date(Date.parse(at));
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + REHEARSAL_PASS_VALID_MONTHS, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

/**
 * The latest rehearsal of each kind decides; GO only when all four exist, passed, and each pass is less than one quarter
 * old at `asAt` (OB-332). A pass older than that reads "not proven".
 */
export function recoveryGateReading(drills: readonly RehearsalRecord[], asAt: string): RecoveryGateReading {
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
    if (!d.result.passed) return { kind, words: REHEARSAL_WORDS[kind], state: 'failed', drillId: d.drillId, drilledAt: d.drilledAt, drilledBy: d.drilledBy, detail: d.result.detail };
    const expiresAt = passExpiresAt(d.drilledAt);
    const expired = Date.parse(asAt) >= Date.parse(expiresAt);
    return {
      kind, words: REHEARSAL_WORDS[kind], state: expired ? 'expired' : 'passed', passExpiresAt: expiresAt,
      drillId: d.drillId, drilledAt: d.drilledAt, drilledBy: d.drilledBy,
      detail: expired ? `not proven — it passed on ${d.drilledAt.slice(0, 10)}, and a pass counts for one quarter (it ran out on ${expiresAt.slice(0, 10)}); rehearse it again` : d.result.detail,
    };
  });
  const notPassed = rehearsals.filter((r) => r.state !== 'passed');
  return {
    gate: 'QG-08',
    verdict: notPassed.length === 0 ? 'GO' : 'HOLD',
    rehearsals,
    unclassifiedDrills: unclassified,
    why: notPassed.length === 0
      ? 'the latest backup restore, store recovery, rollback and incident escalation rehearsals all passed within the last quarter'
      : notPassed.map((r) => `${r.words}: ${r.state === 'missing' ? 'not rehearsed' : r.state === 'expired' ? r.detail : `failed — ${r.detail}`}`).join('; '),
  };
}
