// Parallel run, cutover and rollback — MG-10, MG-11 (§34, §34.1, QG-07, P-01, hard rule #10).
//
// **MG-10 is the only step that tests the new system against reality rather than against
// itself.** Every control total in MG-06 compares a load to an extract; a parallel run compares
// a day's trading to a day's trading. The two systems ring the same sales, and where they
// disagree, one of them is wrong about the shop.
//
//   • **A DIFFERENCE IS OWNED AND VALUED, SAME DAY** (§34.1). Not batched, not reviewed weekly.
//     A parallel run whose differences pile up unresolved is a parallel run producing a backlog
//     instead of confidence, and by day five nobody can tell a new fault from an old one.
//   • **A DIFFERENCE IS NEVER RESOLVED BY PICKING THE NEWER FIGURE** (hard rule #10). It is a
//     visible exception with an owner, and *"the new system is probably right"* is the sentence
//     that ends a parallel run early and starts an inventory problem.
//   • **CLEAN DAYS ARE COUNTED CONSECUTIVELY.** Three clean days after a bad one is not five
//     days of evidence; the counter resets, because whatever caused the bad day is what the run
//     is trying to find.
//
// **MG-11: the rollback is the deliverable, not the cutover.** Anyone can migrate on a good
// night. The checklist below refuses GO until a rollback has been *demonstrated* — not designed,
// not documented, demonstrated — because the decision to roll back gets made at 6am by a tired
// person, and it must be one clearly-labelled action rather than a judgement call.
//
// The store keeps trading throughout (P-01). If the cutover fails, the shop opens.
//
// Pure and deterministic: the clock is injected, no I/O.

export type ComparisonArea = 'sales_value' | 'sales_count' | 'stock_movement' | 'tax' | 'payments' | 'loyalty';

export interface DayComparison {
  readonly area: ComparisonArea;
  readonly legacyValue: number;
  readonly newValue: number;
  /** Tolerance in the same unit. Rounding differs between systems; fraud does not. */
  readonly toleranceMinor: number;
}

export type DifferenceStatus = 'within_tolerance' | 'open' | 'owned' | 'resolved';

export interface ParallelDifference {
  readonly differenceId: string;
  readonly tenantId: string;
  readonly businessDate: string;
  readonly area: ComparisonArea;
  readonly difference: number;
  readonly status: DifferenceStatus;
  readonly ownerUserId?: string;
  readonly explanation?: string;
  /** Which system was wrong. Recorded, because the pattern is the finding. */
  readonly wrongSide?: 'legacy' | 'new' | 'both' | 'neither';
}

export interface ParallelDayResult {
  readonly tenantId: string;
  readonly businessDate: string;
  readonly differences: readonly ParallelDifference[];
  readonly clean: boolean;
  readonly totalDifferenceMinor: number;
  readonly detail: string;
}

/**
 * Compare one day in both systems.
 *
 * Differences are raised **open and unowned**. Assigning an owner is a separate act by a person,
 * because a system that auto-assigns produces a list everybody assumes somebody else is on.
 */
export function compareParallelDay(input: {
  readonly tenantId: string;
  readonly businessDate: string;
  readonly comparisons: readonly DayComparison[];
  readonly idPrefix?: string;
}): ParallelDayResult {
  const prefix = input.idPrefix ?? 'PD';
  const differences: ParallelDifference[] = [];
  let n = 0;
  let totalDifferenceMinor = 0;

  for (const c of input.comparisons) {
    const difference = c.newValue - c.legacyValue;
    if (Math.abs(difference) <= c.toleranceMinor) continue;
    n += 1;
    totalDifferenceMinor += Math.abs(difference);
    differences.push({
      differenceId: `${prefix}-${input.businessDate}-${String(n).padStart(3, '0')}`,
      tenantId: input.tenantId,
      businessDate: input.businessDate,
      area: c.area,
      difference,
      status: 'open',
    });
  }

  const clean = differences.length === 0;
  return {
    tenantId: input.tenantId,
    businessDate: input.businessDate,
    differences,
    clean,
    totalDifferenceMinor,
    detail: clean
      ? `${input.businessDate}: both systems agree across ${input.comparisons.length} areas`
      : `${input.businessDate}: ${differences.length} differences totalling ${totalDifferenceMinor} — each needs an owner today, because by day five nobody can tell a new fault from an old one`,
  };
}

export type OwnRefusal = 'unknown_difference' | 'already_resolved' | 'no_owner' | 'newer_is_not_a_reason';

export interface OwnResult {
  readonly ok: boolean;
  readonly differences: readonly ParallelDifference[];
  readonly refusedBecause?: OwnRefusal;
  readonly detail: string;
}

/** The phrasings that mean "we picked the newer number and moved on" (hard rule #10). */
const NOT_AN_EXPLANATION = /(new system is (probably |presumably )?right|legacy is wrong|took the newer|assume(d)? the new|last write wins|ignore(d)? the old)/i;

/**
 * Give a difference a named owner and, eventually, an explanation.
 *
 * Refuses an explanation that amounts to preferring one system. That is a last-write-wins
 * resolution wearing a sentence, and hard rule #10 exists because the resulting stock error is
 * invisible until a count six weeks later.
 */
export function ownDifference(input: {
  readonly differences: readonly ParallelDifference[];
  readonly differenceId: string;
  readonly ownerUserId: string;
  readonly explanation?: string;
  readonly wrongSide?: 'legacy' | 'new' | 'both' | 'neither';
}): OwnResult {
  const target = input.differences.find((d) => d.differenceId === input.differenceId);
  const unchanged = { ok: false as const, differences: input.differences };

  if (target === undefined) return { ...unchanged, refusedBecause: 'unknown_difference', detail: `no difference ${input.differenceId}` };
  if (target.status === 'resolved') {
    return { ...unchanged, refusedBecause: 'already_resolved', detail: `${input.differenceId} is resolved — its record stands as the evidence` };
  }
  if (input.ownerUserId.trim() === '') {
    return { ...unchanged, refusedBecause: 'no_owner', detail: 'a difference without a named owner is a list item everybody assumes somebody else is on' };
  }
  const explanation = input.explanation?.trim() ?? '';
  if (explanation !== '' && NOT_AN_EXPLANATION.test(explanation)) {
    return {
      ...unchanged, refusedBecause: 'newer_is_not_a_reason',
      detail: `"${explanation}" prefers a system rather than explaining a difference — that is last-write-wins with a sentence in front of it (hard rule #10), and the stock error it hides surfaces at a count six weeks later`,
    };
  }

  const status: DifferenceStatus = explanation === '' ? 'owned' : 'resolved';
  return {
    ok: true,
    differences: input.differences.map((d) => (d.differenceId === input.differenceId
      ? {
        ...d, status, ownerUserId: input.ownerUserId,
        ...(explanation === '' ? {} : { explanation }),
        ...(input.wrongSide === undefined ? {} : { wrongSide: input.wrongSide }),
      }
      : d)),
    detail: status === 'resolved'
      ? `${input.differenceId} resolved by ${input.ownerUserId}: ${explanation}`
      : `${input.differenceId} owned by ${input.ownerUserId}, still to be explained`,
  };
}

export interface ParallelRunPosition {
  readonly daysRun: number;
  /** Consecutive from the most recent day. A bad day resets it, deliberately. */
  readonly consecutiveCleanDays: number;
  readonly openDifferences: readonly ParallelDifference[];
  readonly unownedDifferences: readonly ParallelDifference[];
  readonly valueAtStakeMinor: number;
  readonly sufficient: boolean;
  readonly detail: string;
}

/**
 * Is the parallel run long enough and clean enough to stop?
 *
 * Consecutive is the operative word. A run of clean-bad-clean-clean-clean is four clean days and
 * three days of evidence, because whatever produced the bad day is the thing the run was looking
 * for and only the days after the fix count towards trusting it.
 */
export function parallelRunPosition(input: {
  readonly days: readonly ParallelDayResult[];
  readonly differences: readonly ParallelDifference[];
  readonly requiredCleanDays: number;
}): ParallelRunPosition {
  const ordered = [...input.days].sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1));
  let consecutiveCleanDays = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (!ordered[i]!.clean) break;
    consecutiveCleanDays += 1;
  }

  const openDifferences = input.differences.filter((d) => d.status !== 'resolved');
  const unownedDifferences = openDifferences.filter((d) => d.ownerUserId === undefined);
  const valueAtStakeMinor = openDifferences.reduce((t, d) => t + Math.abs(d.difference), 0);
  const sufficient = consecutiveCleanDays >= input.requiredCleanDays && openDifferences.length === 0;

  return {
    daysRun: ordered.length,
    consecutiveCleanDays,
    openDifferences,
    unownedDifferences,
    valueAtStakeMinor,
    sufficient,
    detail: sufficient
      ? `${consecutiveCleanDays} consecutive clean days over ${ordered.length} run, every difference resolved`
      : `${consecutiveCleanDays} of ${input.requiredCleanDays} consecutive clean days, ${openDifferences.length} differences still open worth ${valueAtStakeMinor} (${unownedDifferences.length} with nobody's name on them)`,
  };
}

// ── MG-11 cutover ─────────────────────────────────────────────────────────────

export type CutoverCheck =
  | 'control_totals_signed'
  | 'rollback_demonstrated'
  | 'parallel_run_sufficient'
  | 'edge_fully_synced'
  | 'blocking_exceptions_cleared'
  | 'delta_applied'
  | 'team_named'
  | 'owner_go';

export interface CutoverChecklist {
  readonly cutoverId: string;
  readonly tenantId: string;
  readonly qg07Passed: boolean;
  /** Demonstrated, not designed. The date it was actually performed. */
  readonly rollbackDemonstratedAt?: string;
  readonly parallelRunSufficient: boolean;
  /** P-01: the store edge has nothing unsynced. An unsynced till is an unmigrated sale. */
  readonly edgeUnsyncedItems: number;
  readonly blockingExceptionsOpen: number;
  readonly deltaApplied: boolean;
  /** Named people on the night, with a role each. "The team" is not a team. */
  readonly namedTeam: readonly { readonly userId: string; readonly role: string }[];
  readonly ownerGoBy?: string;
}

export interface CutoverDecision {
  readonly cutoverId: string;
  readonly go: boolean;
  readonly failed: readonly CutoverCheck[];
  /** P-01: whichever way this goes, the shop opens. Typed so no edit can change it. */
  readonly shopKeepsTrading: true;
  readonly detail: string;
  readonly ownerAction: string;
}

const CHECK_REASON: Readonly<Record<CutoverCheck, string>> = {
  control_totals_signed: 'control totals are not all signed — QG-07 blocks the cutover, and this is the last point a wrong opening balance can be stopped',
  rollback_demonstrated: 'no rollback has been DEMONSTRATED — a designed rollback and a performed one differ on exactly the night it matters, and the decision gets made at 6am by a tired person',
  parallel_run_sufficient: 'the parallel run has not produced enough consecutive clean days with every difference resolved',
  edge_fully_synced: 'the store edge still holds unsynced items — an unsynced till is an unmigrated sale, and it will not be found until the customer asks for the receipt',
  blocking_exceptions_cleared: 'blocking migration exceptions have no decision — the owner may accept any of them knowingly, but none may be inherited by accident',
  delta_applied: 'the delta since the final extract has not been applied — the shop kept trading, so a delta always exists',
  team_named: 'nobody is named for the night — "the team" is not a team at 2am',
  owner_go: 'the owner has not given GO',
};

/**
 * The go/no-go decision, with every failed check named at once.
 *
 * Deliberately reports **all** failures rather than the first: a cutover blocked five ways and
 * reported one way produces five separate evenings, and by the third one the checklist is being
 * argued with rather than worked through.
 */
export function decideCutover(checklist: CutoverChecklist): CutoverDecision {
  const c = checklist;
  const failed: CutoverCheck[] = [];

  if (!c.qg07Passed) failed.push('control_totals_signed');
  if (c.rollbackDemonstratedAt === undefined) failed.push('rollback_demonstrated');
  if (!c.parallelRunSufficient) failed.push('parallel_run_sufficient');
  if (c.edgeUnsyncedItems > 0) failed.push('edge_fully_synced');
  if (c.blockingExceptionsOpen > 0) failed.push('blocking_exceptions_cleared');
  if (!c.deltaApplied) failed.push('delta_applied');
  if (c.namedTeam.length === 0) failed.push('team_named');
  if (c.ownerGoBy === undefined) failed.push('owner_go');

  const go = failed.length === 0;
  return {
    cutoverId: c.cutoverId,
    go,
    failed,
    shopKeepsTrading: true,
    detail: go
      ? `GO: all eight checks passed, ${c.namedTeam.length} named on the night, rollback demonstrated ${c.rollbackDemonstratedAt}`
      : `NO GO — ${failed.length} checks failed: ${failed.map((f) => CHECK_REASON[f]).join('; ')}`,
    ownerAction: go
      ? 'nothing further — the checklist is complete and the cutover may proceed'
      : failed.includes('owner_go') && failed.length === 1
        ? 'every technical check has passed; the cutover waits on your GO'
        : 'no decision is needed from you yet — the failed checks above are ours to clear first',
  };
}

export type RollbackTrigger = 'control_total_failed' | 'edge_cannot_trade' | 'data_corruption' | 'owner_decision' | 'time_window_exceeded';

export interface RollbackResult {
  readonly cutoverId: string;
  readonly performed: boolean;
  readonly trigger: RollbackTrigger;
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** The legacy system is still there because MG-12 never deleted it. */
  readonly legacySystemAvailable: boolean;
  readonly shopKeepsTrading: true;
  /** Migration evidence survives a rollback — hard rule #6. Nothing is unwound. */
  readonly evidenceRetained: true;
  readonly detail: string;
}

/**
 * Roll back.
 *
 * **One clearly-labelled action**, and it needs no committee: the person on the night decides,
 * because a rollback that needs an approval chain gets performed an hour late, and the hour is
 * the whole cost.
 *
 * Nothing about the migration record is unwound. The exceptions, totals, signatures and the
 * failed cutover itself are all retained (hard rule #6) — the second attempt is only cheaper
 * than the first if the first one left its evidence behind.
 */
export function performRollback(input: {
  readonly cutoverId: string;
  readonly trigger: RollbackTrigger;
  readonly decidedBy: string;
  readonly legacySystemAvailable: boolean;
  readonly now: string;
}): RollbackResult {
  return {
    cutoverId: input.cutoverId,
    performed: true,
    trigger: input.trigger,
    decidedBy: input.decidedBy,
    decidedAt: input.now,
    legacySystemAvailable: input.legacySystemAvailable,
    shopKeepsTrading: true,
    evidenceRetained: true,
    detail: input.legacySystemAvailable
      ? `rolled back on ${input.trigger} by ${input.decidedBy} — the legacy system takes the shop, and every piece of migration evidence is retained for the second attempt`
      : `rolled back on ${input.trigger} by ${input.decidedBy}, but the legacy system is NOT available — this is why MG-12 does not retire it on the strength of one good night`,
  };
}
