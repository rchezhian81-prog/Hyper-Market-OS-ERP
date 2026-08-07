// Retention, legal hold and evidence export (M34-FR-02 / PRV-08 / hard rule #6).
//
// Two duties pull in opposite directions and both are real:
//   • privacy says do not keep personal data for ever (PRV-08, defensible deletion);
//   • evidence says never destroy what an audit, a dispute or a court may need
//     (hard rule #6).
//
// The resolution is that NOTHING HERE DELETES ANYTHING. This module produces a
// retention PLAN — what is now beyond its retention period, what is held, what is
// statutorily required, and what has no policy at all. Deletion is a separate,
// authorised, audited act by a human against that plan. A function that quietly
// deleted evidence would be exactly the failure hard rule #6 exists to prevent.
//
// Three things are never eligible, no matter how old:
//   • anything under a LEGAL HOLD (a hold beats retention — M34-FR-02 acceptance);
//   • anything in a class marked STATUTORY (tax and company-law records);
//   • anything with NO POLICY — silence means keep, never means discard.
//
// Pure and deterministic: "now" is passed in, there is no clock.

import type { AuditObjectType, AuditRecord } from './audit-trail';

/** How long one class of evidence is kept — per tenant, chosen not hard-coded. */
export interface RetentionPolicy {
  readonly objectType: AuditObjectType;
  /** Days the evidence must be kept from the date of the action. */
  readonly retainDays: number;
  /**
   * Statutory classes (tax, GST, company law) are never eligible for deletion
   * through this route, however old — the period is a minimum, not a licence.
   */
  readonly statutory?: boolean;
  /** Plain-English basis, shown to the owner and to an auditor. */
  readonly basis?: string;
}

/** A hold that suspends deletion — for a dispute, an investigation or a case. */
export interface LegalHold {
  readonly holdId: string;
  /** Restrict to one object; omit to hold an entire class. */
  readonly objectType?: AuditObjectType;
  readonly objectId?: string;
  /** Restrict to one actor's activity (e.g. an internal investigation). */
  readonly actorId?: string;
  /** Inclusive ISO-8601 lower bound of the period held; omit for open-ended. */
  readonly from?: string;
  /** Exclusive ISO-8601 upper bound of the period held; omit for open-ended. */
  readonly until?: string;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly reason: string;
  /** Set when the hold has been lifted — the hold itself is never erased. */
  readonly liftedAt?: string;
  readonly liftedBy?: string;
}

/** Why a record is being kept, in words the owner can act on. */
export type RetentionOutcome =
  | 'within_retention'
  | 'legal_hold'
  | 'statutory'
  | 'no_policy'
  | 'eligible_for_review';

export interface RetentionDecision {
  readonly sequence: number;
  readonly objectType: AuditObjectType;
  readonly objectId: string;
  readonly at: string;
  readonly outcome: RetentionOutcome;
  /** The hold that keeps it, when the outcome is `legal_hold`. */
  readonly holdId?: string;
  readonly explanation: string;
}

export interface RetentionPlan {
  readonly asOf: string;
  readonly decisions: readonly RetentionDecision[];
  /**
   * Records past their retention period with nothing holding them. NOT deleted —
   * proposed for an authorised human decision, which is itself audited.
   */
  readonly eligibleForReview: readonly RetentionDecision[];
  readonly heldCount: number;
  readonly statutoryCount: number;
  readonly noPolicyCount: number;
}

/** A hold applies to a record when every stated restriction matches. */
export function holdApplies(hold: LegalHold, record: AuditRecord): boolean {
  if (hold.liftedAt !== undefined) return false;
  if (hold.objectType !== undefined && hold.objectType !== record.objectType) return false;
  if (hold.objectId !== undefined && hold.objectId !== record.objectId) return false;
  if (hold.actorId !== undefined && hold.actorId !== record.actorId) return false;
  if (hold.from !== undefined && record.at < hold.from) return false;
  if (hold.until !== undefined && record.at >= hold.until) return false;
  return true;
}

const MS_PER_DAY = 86_400_000;

/** Whole days between two ISO-8601 instants; negative when `at` precedes `from`. */
function daysBetween(from: string, at: string): number {
  return Math.floor((Date.parse(at) - Date.parse(from)) / MS_PER_DAY);
}

/**
 * Build the retention plan for a set of audit records. Deletes nothing, ever —
 * it reports what a human may then decide about, with the reason for every
 * record that stays (M34-FR-02).
 */
export function planRetention(
  records: readonly AuditRecord[],
  policies: readonly RetentionPolicy[],
  holds: readonly LegalHold[],
  asOf: string,
): RetentionPlan {
  const byType = new Map(policies.map((p) => [p.objectType, p]));

  const decisions = records.map((record): RetentionDecision => {
    const base = {
      sequence: record.sequence,
      objectType: record.objectType,
      objectId: record.objectId,
      at: record.at,
    };

    // A hold outranks everything, including an expired retention period.
    const hold = holds.find((h) => holdApplies(h, record));
    if (hold) {
      return {
        ...base,
        outcome: 'legal_hold',
        holdId: hold.holdId,
        explanation: `held by ${hold.holdId} (${hold.reason}) — a hold survives the retention date`,
      };
    }

    const policy = byType.get(record.objectType);
    if (!policy) {
      return {
        ...base,
        outcome: 'no_policy',
        explanation: `no retention policy for "${record.objectType}" — kept, because silence never means discard`,
      };
    }

    if (policy.statutory === true) {
      return {
        ...base,
        outcome: 'statutory',
        explanation: `statutory class${policy.basis === undefined ? '' : ` (${policy.basis})`} — never deleted through retention`,
      };
    }

    const age = daysBetween(record.at, asOf);
    if (age < policy.retainDays) {
      return {
        ...base,
        outcome: 'within_retention',
        explanation: `kept ${policy.retainDays} days; ${policy.retainDays - age} to go`,
      };
    }

    return {
      ...base,
      outcome: 'eligible_for_review',
      explanation: `past its ${policy.retainDays}-day retention (${age} days old) — needs an authorised human decision; nothing is deleted here`,
    };
  });

  return {
    asOf,
    decisions,
    eligibleForReview: decisions.filter((d) => d.outcome === 'eligible_for_review'),
    heldCount: decisions.filter((d) => d.outcome === 'legal_hold').length,
    statutoryCount: decisions.filter((d) => d.outcome === 'statutory').length,
    noPolicyCount: decisions.filter((d) => d.outcome === 'no_policy').length,
  };
}

/** Lift a hold — recorded as a new state, never by erasing the original. */
export function liftHold(hold: LegalHold, by: string, at: string): LegalHold {
  return { ...hold, liftedAt: at, liftedBy: by };
}

/** An evidence pack handed to an auditor, inspector or court (M34-FR-02). */
export interface EvidencePack {
  readonly exportedBy: string;
  readonly exportedAt: string;
  readonly from: string;
  readonly until: string;
  readonly records: readonly AuditRecord[];
  /**
   * The seal of the last record in the pack, so the recipient can prove the pack
   * matches the trail it was taken from.
   */
  readonly chainHash: string;
  /** True when the trail the pack came from verified end-to-end at export time. */
  readonly sourceIntact: boolean;
}

/**
 * Assemble an evidence pack for a period. The export itself is a sensitive action:
 * the caller records it in the trail (the returned pack names who and when), which
 * is why nothing is exported anonymously.
 */
export function buildEvidencePack(input: {
  readonly records: readonly AuditRecord[];
  readonly from: string;
  readonly until: string;
  readonly exportedBy: string;
  readonly exportedAt: string;
  readonly sourceIntact: boolean;
}): EvidencePack {
  const inPeriod = input.records.filter((r) => r.at >= input.from && r.at < input.until);
  return {
    exportedBy: input.exportedBy,
    exportedAt: input.exportedAt,
    from: input.from,
    until: input.until,
    records: inPeriod,
    chainHash: inPeriod[inPeriod.length - 1]?.hash ?? '',
    sourceIntact: input.sourceIntact,
  };
}
