// History, exclusions and archive — MG-07, MG-12 (§34, OD-05, OD-06, hard rule #6).
//
// Two steps about the same question: **what is kept, and who said so.**
//
// MG-07 is where a migration silently becomes smaller than it was promised. The pressure is
// entirely practical — fifteen years of documents make the load slow, the old data is messy, and
// *"nobody looks at 2013 anyway"* is usually true. It is also not the migrator's decision. OD-05
// says all **usable** previous-system data is migrated and that exceptions require **owner
// approval**, so:
//
//   • **AN EXCLUSION IS A WRITTEN OWNER DECISION, NAMED AND VALUED.** Not a config cutoff, not a
//     default retention window, not a sensible assumption. `proposeExclusion` produces a
//     proposal; only `approveExclusion` makes it real, and only the owner's approval counts.
//   • **AN UNAPPROVED EXCLUSION IS NOT A SMALLER MIGRATION — IT IS AN OPEN ITEM.** It appears in
//     the reconciliation as an unexplained difference rather than quietly shrinking the legacy
//     side, which is the version of this that gets caught.
//   • **"USABLE" IS ASSESSED, NOT ASSUMED.** A document whose lines are orphaned, whose customer
//     no longer exists or whose total does not add up is a candidate for exclusion with a
//     reason. Age alone is never a reason on its own — a warranty claim in year four is exactly
//     the record somebody needs.
//
// MG-12 is the opposite risk. The legacy system is expensive, the licence is up for renewal, and
// the day after a successful cutover somebody suggests turning it off:
//
//   • **RETENTION IS A DATE, AND IT IS IN THE FUTURE.** `mayRetire` is computed from the legal
//     retention period against the archive's own dates, not from how confident anyone feels.
//   • **THE ARCHIVE IS READ-ONLY AND IT IS NEVER DELETED** (hard rule #6). There is no
//     `deleteArchive` in this file, asserted by test. Retiring the legacy *system* and destroying
//     the legacy *data* are different acts, and conflating them is how a GST assessment for an
//     earlier year becomes unanswerable.
//
// Pure and deterministic: the clock is injected, no I/O.

export type ExclusionScope = 'documents_before' | 'entity_kind' | 'named_records' | 'inactive_records';

export type ExclusionStatus = 'proposed' | 'approved' | 'rejected';

export interface HistoryExclusion {
  readonly exclusionId: string;
  readonly tenantId: string;
  readonly scope: ExclusionScope;
  /** What is being left behind, in words the owner can check against the old system. */
  readonly description: string;
  readonly recordCount: number;
  /** The money in the excluded records. An exclusion with no value stated is not assessable. */
  readonly valueMinor: number;
  readonly proposedBy: string;
  readonly proposedAt: string;
  /** Why this data is not usable. Age alone is never sufficient. */
  readonly reason: string;
  readonly status: ExclusionStatus;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly ownerStatement?: string;
}

export type ProposeRefusal = 'no_reason' | 'age_alone' | 'no_value_stated' | 'nothing_excluded';

export interface ProposeResult {
  readonly ok: boolean;
  readonly exclusion?: HistoryExclusion;
  readonly refusedBecause?: ProposeRefusal;
  readonly detail: string;
}

/** Reasons that are really "it is old", wearing different words. */
const AGE_ONLY = /^(too old|old data|before \d{4}|older than \d+ years?|legacy|historic(al)?|not needed)\.?$/i;

/**
 * Propose leaving data behind.
 *
 * Refuses **age as the sole reason**, which is the reason offered ninety per cent of the time
 * and the one that is never actually true. *"Documents before 2019, because the tax rates
 * changed and restating them would rewrite filed returns"* is a reason. *"Documents before
 * 2019"* is a preference with a date on it.
 */
export function proposeExclusion(input: {
  readonly exclusionId: string;
  readonly tenantId: string;
  readonly scope: ExclusionScope;
  readonly description: string;
  readonly recordCount: number;
  readonly valueMinor: number;
  readonly reason: string;
  readonly proposedBy: string;
  readonly now: string;
}): ProposeResult {
  if (input.recordCount <= 0) {
    return { ok: false, refusedBecause: 'nothing_excluded', detail: 'an exclusion covering no records is a decision about nothing' };
  }
  const reason = input.reason.trim();
  if (reason === '') {
    return { ok: false, refusedBecause: 'no_reason', detail: 'an exclusion with no reason cannot be approved, because there is nothing to approve' };
  }
  if (AGE_ONLY.test(reason)) {
    return {
      ok: false, refusedBecause: 'age_alone',
      detail: `"${reason}" is age, not unusability — a warranty claim in year four is exactly the record somebody needs, and OD-05 says all USABLE data is migrated`,
    };
  }
  if (!Number.isFinite(input.valueMinor)) {
    return { ok: false, refusedBecause: 'no_value_stated', detail: 'an exclusion must state the money it covers — an unvalued exclusion cannot be assessed and cannot be reconciled against' };
  }

  return {
    ok: true,
    exclusion: {
      exclusionId: input.exclusionId, tenantId: input.tenantId, scope: input.scope,
      description: input.description, recordCount: input.recordCount, valueMinor: input.valueMinor,
      proposedBy: input.proposedBy, proposedAt: input.now, reason, status: 'proposed',
    },
    detail: `proposed leaving ${input.recordCount} records worth ${input.valueMinor} behind: ${reason}`,
  };
}

export type ApproveExclusionRefusal = 'not_proposed' | 'not_the_owner' | 'proposer_cannot_approve' | 'no_statement';

export interface ApproveExclusionResult {
  readonly ok: boolean;
  readonly exclusion?: HistoryExclusion;
  readonly refusedBecause?: ApproveExclusionRefusal;
  readonly detail: string;
}

/**
 * The owner approves — or rejects — an exclusion, in writing.
 *
 * The proposer cannot approve their own proposal even if they are the owner. The person who
 * decided the data is not worth migrating is not the person to confirm it, and on a
 * single-owner business the temptation to collapse the two roles is exactly why the check is
 * written down.
 */
export function approveExclusion(input: {
  readonly exclusion: HistoryExclusion;
  readonly decidedBy: string;
  readonly decidedByIsOwner: boolean;
  readonly approve: boolean;
  readonly ownerStatement: string;
  readonly now: string;
}): ApproveExclusionResult {
  const e = input.exclusion;
  if (e.status !== 'proposed') {
    return { ok: false, refusedBecause: 'not_proposed', detail: `${e.exclusionId} is ${e.status}, not proposed — a decided exclusion stays decided, and its record is the evidence` };
  }
  if (!input.decidedByIsOwner) {
    return {
      ok: false, refusedBecause: 'not_the_owner',
      detail: `OD-05 requires OWNER approval for an exclusion — ${input.decidedBy} cannot decide that ${e.recordCount} records worth ${e.valueMinor} are not migrated`,
    };
  }
  if (input.decidedBy === e.proposedBy) {
    return {
      ok: false, refusedBecause: 'proposer_cannot_approve',
      detail: `${input.decidedBy} proposed this exclusion and cannot also approve it — the person who decided the data is not worth migrating is not the person to confirm it`,
    };
  }
  if (input.ownerStatement.trim() === '') {
    return { ok: false, refusedBecause: 'no_statement', detail: 'the decision must be in writing — a year later the record is all there is' };
  }

  return {
    ok: true,
    exclusion: {
      ...e,
      status: input.approve ? 'approved' : 'rejected',
      approvedBy: input.decidedBy,
      approvedAt: input.now,
      ownerStatement: input.ownerStatement,
    },
    detail: input.approve
      ? `${e.exclusionId} approved by the owner: ${e.recordCount} records worth ${e.valueMinor} are not migrated, and the reconciliation must account for exactly that figure`
      : `${e.exclusionId} rejected by the owner — the records are migrated`,
  };
}

export interface ExclusionPosition {
  readonly approved: readonly HistoryExclusion[];
  readonly awaitingOwner: readonly HistoryExclusion[];
  /** The figure the reconciliation may legitimately be short by (MG-06). */
  readonly approvedValueMinor: number;
  readonly approvedRecords: number;
  /** Value sitting in exclusions nobody has decided. NOT deductible from any total. */
  readonly undecidedValueMinor: number;
  readonly detail: string;
}

/**
 * What the exclusions add up to, split by whether anybody approved them.
 *
 * The split is the point. Only the approved figure may explain a control-total difference; an
 * undecided exclusion leaves the difference open, which is what forces the decision to happen
 * before cutover rather than after.
 */
export function exclusionPosition(exclusions: readonly HistoryExclusion[]): ExclusionPosition {
  const approved = exclusions.filter((e) => e.status === 'approved');
  const awaitingOwner = exclusions.filter((e) => e.status === 'proposed');
  const approvedValueMinor = approved.reduce((t, e) => t + e.valueMinor, 0);
  const approvedRecords = approved.reduce((t, e) => t + e.recordCount, 0);
  const undecidedValueMinor = awaitingOwner.reduce((t, e) => t + e.valueMinor, 0);

  return {
    approved, awaitingOwner, approvedValueMinor, approvedRecords, undecidedValueMinor,
    detail: awaitingOwner.length === 0
      ? `${approved.length} approved exclusions covering ${approvedRecords} records worth ${approvedValueMinor}`
      : `${awaitingOwner.length} exclusions worth ${undecidedValueMinor} await the owner — until decided they explain nothing, and the totals they affect stay open`,
  };
}

// ── MG-12 archive and retirement ──────────────────────────────────────────────

export interface LegacyArchive {
  readonly archiveId: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly digest: string;
  readonly rowCount: number;
  readonly archivedAt: string;
  /** Statutory or owner-set. Drives the date, and nothing else does. */
  readonly retentionYears: number;
  /** The oldest business date inside. Retention runs from the DATA, not the archive job. */
  readonly earliestRecordDate: string;
  readonly latestRecordDate: string;
  readonly readOnly: true;
  /** Whether a restore from this archive has been demonstrated. An untested archive is a hope. */
  readonly restoreVerifiedAt?: string;
}

export type RetireBlocker =
  | 'retention_not_elapsed'
  | 'restore_never_verified'
  | 'cutover_not_accepted'
  | 'open_assessment';

export interface RetirementAssessment {
  readonly archiveId: string;
  readonly mayRetireSystem: boolean;
  readonly blockedBy: readonly RetireBlocker[];
  readonly retentionEndsOn: string;
  /** Retiring the legacy SYSTEM never destroys the legacy DATA. Typed so it cannot drift. */
  readonly dataIsNeverDeleted: true;
  readonly detail: string;
}

/** Retention runs from the latest record, since that is the last one an assessment can reach. */
function retentionEnd(latestRecordDate: string, years: number): string {
  const year = Number(latestRecordDate.slice(0, 4)) + years;
  return `${year}${latestRecordDate.slice(4)}`;
}

/**
 * May the legacy **system** be switched off?
 *
 * Every blocker at once, not the first one found — a retirement blocked three ways and reported
 * one way gets re-asked three times, and by the third time somebody stops reading the answer.
 *
 * `dataIsNeverDeleted` is typed as the literal `true` because the two acts get conflated
 * constantly: the licence renewal is the pressure, switching the server off is the action, and
 * deleting the archive is the thing that quietly happens alongside it. OD-06 retires the
 * adapter and the system; hard rule #6 keeps the data.
 */
export function assessRetirement(input: {
  readonly archive: LegacyArchive;
  readonly cutoverAccepted: boolean;
  readonly openAssessments: number;
  readonly today: string;
}): RetirementAssessment {
  const a = input.archive;
  const retentionEndsOn = retentionEnd(a.latestRecordDate, a.retentionYears);
  const blockedBy: RetireBlocker[] = [];

  if (input.today < retentionEndsOn) blockedBy.push('retention_not_elapsed');
  if (a.restoreVerifiedAt === undefined) blockedBy.push('restore_never_verified');
  if (!input.cutoverAccepted) blockedBy.push('cutover_not_accepted');
  if (input.openAssessments > 0) blockedBy.push('open_assessment');

  const mayRetireSystem = blockedBy.length === 0;
  const reasons: Readonly<Record<RetireBlocker, string>> = {
    retention_not_elapsed: `retention runs to ${retentionEndsOn} (${a.retentionYears} years from the latest record, ${a.latestRecordDate})`,
    restore_never_verified: 'no restore from this archive has ever been demonstrated — an untested archive is a hope, and it is tested when it is needed',
    cutover_not_accepted: 'the cutover has not been accepted — the legacy system is still the fallback',
    open_assessment: `${input.openAssessments} open assessments could still need these records`,
  };

  return {
    archiveId: a.archiveId,
    mayRetireSystem,
    blockedBy,
    retentionEndsOn,
    dataIsNeverDeleted: true,
    detail: mayRetireSystem
      ? `the legacy system may be retired (OD-06) — the archive stays, read-only, and is never deleted (hard rule #6)`
      : `the legacy system may not be retired: ${blockedBy.map((b) => reasons[b]).join('; ')}`,
  };
}
