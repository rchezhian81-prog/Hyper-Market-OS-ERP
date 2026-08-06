// The cutover checklist, DERIVED — MG-11 (§34, QG-07, P-01, P-08, hard rule #10).
//
// ── What was missing, and why it is the worst place for it to be missing ────
//
// `decideCutover` refuses GO until all eight checks pass, reports every failure at once, and
// types `shopKeepsTrading` as the literal `true`. It is the gate on the single most irreversible
// action in this entire project: the night SRE Hyper Market stops running on the old system.
//
// **It takes a `CutoverChecklist` of booleans supplied by the caller, and nothing in this
// codebase has ever derived one.** In every call site — both integration tests and the unit
// test — the checklist is a literal with `qg07Passed: true`, `parallelRunSufficient: true`,
// `edgeUnsyncedItems: 0`, `deltaApplied: true` typed in by hand. So the eight-check gate has
// never once been asked about the actual state of the migration; it has only ever been told.
//
// That is the same shape as `alreadyReturnedMinor` in returns — a rule enforced against a number
// the caller must compute, and nothing computing it — except that here the consequence is not a
// duplicate refund. It is a shop that opens on Monday on an opening balance nobody checked.
//
// And every one of the eight already has a real producer sitting beside it:
//
//   • `assessReconciliation(...).qg07Passed`            — from signed control totals
//   • `parallelRunPosition(...).sufficient`             — from consecutive clean days
//   • `outstandingExceptions(...).blockingUnresolved`   — from undecided blocking exceptions
//   • the store box's own outbox                        — from what has not reached the cloud
//   • the delta, the rollback, the team and the GO      — from records of things that happened
//
// This module is the join. Nothing here decides anything new; it refuses to let the decision be
// made on assertions.
//
// ── The rule that makes it worth having ─────────────────────────────────────
//
// **NOT KNOWN FAILS.** Every input is optional, and an absent one does not become a comfortable
// default — no `?? 0` on the unsynced count, no `?? true` anywhere. A box that was never told
// how many sales are unsynced must not report a cutover as clear to proceed, because "nobody
// told me" and "there are none" are opposite facts and only one of them is good news.
//
// Pure and deterministic: every input is passed in, no clock, no I/O.

import type { OutstandingExceptions } from './cleaning';
import type { ReconciliationReport } from './reconcile';
import type { CutoverCheck, CutoverChecklist, ParallelRunPosition } from './cutover';

/** A named person on the night, with a role each. "The team" is not a team at 2am. */
export interface TeamMember {
  readonly userId: string;
  readonly role: string;
}

/**
 * The evidence a checklist is derived from.
 *
 * **Every field is optional and every absence is a failure**, never a pass. The type says so:
 * there is no non-optional field anywhere here that could be silently defaulted.
 */
export interface CutoverEvidence {
  /** From `assessReconciliation`. Absent means no control totals have been recorded at all. */
  readonly reconciliation?: ReconciliationReport;
  /** From `parallelRunPosition`. Absent means no parallel run has been recorded. */
  readonly parallel?: ParallelRunPosition;
  /** From `outstandingExceptions`. Absent means the cleaning pass has never been run. */
  readonly exceptions?: OutstandingExceptions;
  /**
   * What the store box still holds unsynced, from its own outbox.
   *
   * **Absent is not nought.** An unsynced till is an unmigrated sale, and it is not found until
   * a customer asks for the receipt.
   */
  readonly edgeUnsyncedItems?: number;
  /** When the delta since the final extract was applied. Absent means it has not been. */
  readonly deltaAppliedAt?: string;
  /** When a rollback was **performed**. A designed one leaves this absent, deliberately. */
  readonly rollbackDemonstratedAt?: string;
  readonly namedTeam?: readonly TeamMember[];
  /** When the owner gave GO. Absent means they have not. */
  readonly ownerGoBy?: string;
}

/** Whether a check passed, and — the part that matters — whether it was answerable at all. */
export type CheckState = 'passed' | 'failed' | 'not_known';

export interface DerivedCheck {
  readonly check: CutoverCheck;
  readonly state: CheckState;
  /** Where the answer came from, in words, so nobody has to take the tick on trust. */
  readonly evidence: string;
}

export interface DerivedChecklist {
  /** Ready for `decideCutover`. Every field computed; none of them asserted. */
  readonly checklist: CutoverChecklist;
  readonly checks: readonly DerivedCheck[];
  /** Checks nothing could answer. These fail, and they need a different fix from a failure. */
  readonly notKnown: readonly CutoverCheck[];
  readonly detail: string;
}

/**
 * Build the checklist from what is actually true, or say what could not be answered.
 *
 * A check that could not be answered is reported `not_known` **and passed to `decideCutover` as
 * a failure**, because the two need different actions from different people — a failed check is
 * work to finish, and an unanswerable one means a producer is not connected — but neither of
 * them is a cutover.
 */
export function buildCutoverChecklist(input: {
  readonly cutoverId: string;
  readonly tenantId: string;
  readonly evidence: CutoverEvidence;
}): DerivedChecklist {
  const e = input.evidence;
  const checks: DerivedCheck[] = [];

  const record = (check: CutoverCheck, state: CheckState, evidence: string): void => {
    checks.push({ check, state, evidence });
  };

  // 1. QG-07 — every control total reconciled or explained AND signed.
  if (e.reconciliation === undefined) {
    record('control_totals_signed', 'not_known',
      'no control totals have been recorded at all, so QG-07 has nothing to pass on — an empty report is the easiest one to produce');
  } else {
    record('control_totals_signed', e.reconciliation.qg07Passed ? 'passed' : 'failed',
      e.reconciliation.detail);
  }
  const qg07Passed = e.reconciliation?.qg07Passed === true;

  // 2. The rollback — DEMONSTRATED, never designed.
  record('rollback_demonstrated',
    e.rollbackDemonstratedAt === undefined ? 'failed' : 'passed',
    e.rollbackDemonstratedAt === undefined
      ? 'no rollback has been performed — a designed rollback and a performed one differ on exactly the night it matters'
      : `a rollback was actually performed on ${e.rollbackDemonstratedAt}`);

  // 3. The parallel run — consecutive clean days, every difference resolved.
  if (e.parallel === undefined) {
    record('parallel_run_sufficient', 'not_known',
      'no parallel run has been recorded — the only step that tests the new system against a day of real trading rather than against itself');
  } else {
    record('parallel_run_sufficient', e.parallel.sufficient ? 'passed' : 'failed', e.parallel.detail);
  }
  const parallelRunSufficient = e.parallel?.sufficient === true;

  // 4. The store edge — nothing unsynced. **Absent is not nought.**
  if (e.edgeUnsyncedItems === undefined) {
    record('edge_fully_synced', 'not_known',
      'nothing has told this screen what the store box still holds — an unsynced till is an unmigrated sale, and a substituted nought here reads as "all clear"');
  } else {
    record('edge_fully_synced', e.edgeUnsyncedItems === 0 ? 'passed' : 'failed',
      e.edgeUnsyncedItems === 0
        ? 'the store box has nothing waiting to reach the cloud'
        : `the store box still holds ${e.edgeUnsyncedItems} items that have never reached the cloud`);
  }

  // 5. Blocking exceptions — cleared by a DECISION, including a decision to migrate as is.
  if (e.exceptions === undefined) {
    record('blocking_exceptions_cleared', 'not_known',
      'the cleaning pass has never been run, so nothing is known about what is wrong with the data');
  } else {
    record('blocking_exceptions_cleared', e.exceptions.clearForCutover ? 'passed' : 'failed',
      e.exceptions.detail);
  }

  // 6. The delta — the shop kept trading, so one always exists.
  record('delta_applied',
    e.deltaAppliedAt === undefined ? 'failed' : 'passed',
    e.deltaAppliedAt === undefined
      ? 'the changes since the final extract have not been loaded — the shop kept trading, so there are always some'
      : `the delta since the final extract was applied on ${e.deltaAppliedAt}`);

  // 7. The team — named people, with a role each.
  const team = e.namedTeam ?? [];
  record('team_named',
    e.namedTeam === undefined ? 'not_known' : team.length > 0 ? 'passed' : 'failed',
    e.namedTeam === undefined
      ? 'nothing has told this screen who is on the night'
      : team.length > 0
        ? `${team.map((m) => `${m.userId} (${m.role})`).join(', ')}`
        : 'nobody is named for the night — "the team" is not a team at 2am');

  // 8. The owner's GO. Last, and it is the only one that is theirs.
  record('owner_go',
    e.ownerGoBy === undefined ? 'failed' : 'passed',
    e.ownerGoBy === undefined
      ? 'the owner has not given GO — the last of the eight, and the only one that is theirs'
      : `the owner gave GO in the name of ${e.ownerGoBy}`);

  const notKnown = checks.filter((c) => c.state === 'not_known').map((c) => c.check);

  // **Every "not known" arrives at `decideCutover` as a failure.** The booleans below are the
  // only place an absence could have become a pass, and none of them does.
  const checklist: CutoverChecklist = {
    cutoverId: input.cutoverId,
    tenantId: input.tenantId,
    qg07Passed,
    ...(e.rollbackDemonstratedAt === undefined ? {} : { rollbackDemonstratedAt: e.rollbackDemonstratedAt }),
    parallelRunSufficient,
    // Not `?? 0`. An unknown count is reported as one outstanding item so the check fails, and
    // the `not_known` list says which of the two it is.
    edgeUnsyncedItems: e.edgeUnsyncedItems === undefined ? 1 : e.edgeUnsyncedItems,
    blockingExceptionsOpen: e.exceptions === undefined ? 1 : e.exceptions.blockingUnresolved.length,
    deltaApplied: e.deltaAppliedAt !== undefined,
    namedTeam: team,
    ...(e.ownerGoBy === undefined ? {} : { ownerGoBy: e.ownerGoBy }),
  };

  const failed = checks.filter((c) => c.state !== 'passed');
  return {
    checklist,
    checks,
    notKnown,
    detail: failed.length === 0
      ? 'all eight checks answered from evidence and all eight passed'
      : notKnown.length === 0
        ? `${failed.length} of eight checks failed, every one answered from evidence`
        : `${failed.length} of eight checks failed, and ${notKnown.length} of those could not be answered at all — an unanswerable check is a producer that is not connected, not a shop that is ready`,
  };
}
