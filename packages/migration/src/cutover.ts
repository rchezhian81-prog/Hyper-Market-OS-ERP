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

/**
 * Where a rollback stands (audit GT-02). A decision is NOT a rollback: the shop is back on the old system only when
 * somebody has seen the old system take a sale after the decision.
 *   • `decided` — the person on the night decided to go back; the old system has not yet been seen trading;
 *   • `legacy_unavailable` — decided, but the old system is not there to take the shop; it can never be confirmed;
 *   • `performed` — confirmed with execution evidence: the old system's first bill after the decision, and when it
 *     started taking sales again.
 */
export type RollbackState = 'decided' | 'legacy_unavailable' | 'performed';

/** The execution evidence that turns a decided rollback into a performed one (GT-02). */
export interface RollbackExecution {
  /** The signed-in person who saw the old system trading — never a typed name. */
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  /** When the old system started taking sales again. Not before the decision. */
  readonly legacyTradingFrom: string;
  /** The old system's first bill number after the decision — something anybody can go and look at. */
  readonly legacyFirstBillRef: string;
}

export interface RollbackResult {
  readonly cutoverId: string;
  /** True ONLY when execution evidence was recorded (`state: performed`). A decision alone is never performed. */
  readonly performed: boolean;
  readonly state: RollbackState;
  readonly trigger: RollbackTrigger;
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** The legacy system is still there because MG-12 never deleted it. */
  readonly legacySystemAvailable: boolean;
  readonly shopKeepsTrading: true;
  /** Migration evidence survives a rollback — hard rule #6. Nothing is unwound. */
  readonly evidenceRetained: true;
  /** Present only when performed: what was seen, by whom. */
  readonly execution?: RollbackExecution;
  readonly detail: string;
}

/**
 * Decide to roll back.
 *
 * **One clearly-labelled action**, and it needs no committee: the person on the night decides,
 * because a rollback that needs an approval chain gets performed an hour late, and the hour is
 * the whole cost.
 *
 * It returns a DECISION, never a performed rollback (audit GT-02): the old system is back only when somebody has seen
 * it take a sale — `confirmRollback`. Until then nothing may say "gone back".
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
    performed: false,
    state: input.legacySystemAvailable ? 'decided' : 'legacy_unavailable',
    trigger: input.trigger,
    decidedBy: input.decidedBy,
    decidedAt: input.now,
    legacySystemAvailable: input.legacySystemAvailable,
    shopKeepsTrading: true,
    evidenceRetained: true,
    detail: input.legacySystemAvailable
      ? `rollback decided on ${input.trigger} by ${input.decidedBy} — NOT yet performed: it is performed when somebody sees the old system take its first sale and records that bill; every piece of migration evidence is retained for the second attempt`
      : `rollback decided on ${input.trigger} by ${input.decidedBy}, but the legacy system is NOT available, so it cannot be performed — this is why MG-12 does not retire it on the strength of one good night. Keep trading on the new system and call for help`,
  };
}

export type RollbackConfirmationRefusal = 'legacy_unavailable' | 'already_performed' | 'no_bill_reference' | 'trading_before_the_decision' | 'not_a_time';

/**
 * Confirm a decided rollback with EXECUTION evidence (audit GT-02): the old system's first bill after the decision and
 * when it started trading, seen by a signed-in person. Refused — with the reason — when the old system was not there,
 * when it is already confirmed, when there is no bill to look at, or when the trading is said to predate the decision.
 */
export function confirmRollback(decided: RollbackResult, execution: RollbackExecution):
  { readonly ok: true; readonly rollback: RollbackResult } | { readonly ok: false; readonly refusal: RollbackConfirmationRefusal; readonly detail: string } {
  if (decided.state === 'performed') return { ok: false, refusal: 'already_performed', detail: `the rollback of ${decided.cutoverId} was already confirmed by ${decided.execution?.confirmedBy ?? 'someone'}` };
  if (!decided.legacySystemAvailable || decided.state === 'legacy_unavailable') {
    return { ok: false, refusal: 'legacy_unavailable', detail: 'the old system was recorded as NOT available when the rollback was decided, so there is nothing to confirm — a rollback onto a system that is not there is not a rollback' };
  }
  if (execution.legacyFirstBillRef.trim() === '') return { ok: false, refusal: 'no_bill_reference', detail: 'name the first bill the old system took after the decision — the evidence anybody can go and look at' };
  if (Number.isNaN(Date.parse(execution.legacyTradingFrom)) || Number.isNaN(Date.parse(execution.confirmedAt))) {
    return { ok: false, refusal: 'not_a_time', detail: 'when the old system started trading must be a time' };
  }
  if (Date.parse(execution.legacyTradingFrom) < Date.parse(decided.decidedAt)) {
    return { ok: false, refusal: 'trading_before_the_decision', detail: `the old system's trading from ${execution.legacyTradingFrom} is before the rollback was decided at ${decided.decidedAt} — that bill does not show the rollback happened` };
  }
  return {
    ok: true,
    rollback: {
      ...decided,
      performed: true,
      state: 'performed',
      execution,
      detail: `rolled back on ${decided.trigger}: decided by ${decided.decidedBy} at ${decided.decidedAt}; the old system has been taking sales since ${execution.legacyTradingFrom} (first bill ${execution.legacyFirstBillRef}), seen by ${execution.confirmedBy} — every piece of migration evidence is retained for the second attempt`,
    },
  };
}

// ── GT-02: the rollback rehearsal reconciles the data it hands back ─────────────────────────────────────────────────

/** A count and a money total — what one side holds for the rollback window. */
export interface WindowTotals {
  readonly count: number;
  readonly totalMinor: number;
}

/**
 * OB-50 "A" (owner, 11 Oct 2026): a rollback reconciles more than bills and takings — the REFUNDS the new system gave in
 * the window (count, value) and the STOCK it moved, per product (net effect on hand, in the product's own unit), must
 * be in the old system too.
 */
export interface RollbackWindowFacts {
  readonly refunds: WindowTotals;
  /** Per product: the net quantity the window's movements put on (+) or took off (−) hand. Sorted by product id. */
  readonly stockMovements: readonly { readonly productId: string; readonly netQuantityMinor: number }[];
}

/** A store computer's last complete sync of its sales (EA-01) — what says its sales have all reached head office. */
export interface StoreSyncedThrough {
  readonly storeId: string;
  readonly completeThrough: string | null;
}

/**
 * The data side of a rollback (audit GT-02 · MG-11 · QG-08): everything the NEW system took between when it started
 * trading and when the tills went back to the old one must be in the old system afterwards — count for count, paisa
 * for paisa. Head office counts its own side from its sales ledger; the operator records what the old system now
 * holds from the carry-back. Reconciled only when they are equal.
 */
export interface RollbackReconciliation {
  readonly cutoverId: string;
  /** The rollback decision this reconciles (its decision time identifies it). */
  readonly decidedAt: string;
  readonly windowFrom: string;
  /** When the old system took over again — the end of the new system's window. */
  readonly windowTo: string;
  readonly newSystem: WindowTotals;
  readonly legacy: WindowTotals;
  /** OB-50: the refunds and per-product stock movements on each side (absent on reconciliations recorded before OB-50). */
  readonly newSystemFacts?: RollbackWindowFacts;
  readonly legacyFacts?: RollbackWindowFacts;
  /** Each store's last complete sync at the time — every one past the switch-back, or this is refused. */
  readonly stores: readonly StoreSyncedThrough[];
  readonly reconciled: boolean;
  readonly differences: readonly string[];
  readonly by: string;
  readonly at: string;
  readonly detail: string;
}

export type RollbackReconciliationRefusal = 'not_performed' | 'not_a_time' | 'window_after_switch_back' | 'no_store_sync_report' | 'store_not_synced_through_switch_back';

/**
 * Reconcile a PERFORMED rollback's window (GT-02). Refused while the rollback is only decided; refused while any store
 * computer has not synced past the switch-back (its unsent sales would be missing from head office's count — store
 * sync is part of the reconciliation, never assumed); otherwise the two sides are compared exactly and every
 * difference is named. A reconciliation that does not balance is still recorded (it is evidence), as NOT reconciled.
 */
export function reconcileRollback(input: {
  readonly rollback: RollbackResult;
  readonly windowFrom: string;
  readonly newSystem: WindowTotals;
  readonly legacy: WindowTotals;
  /** OB-50: head office's own refunds and stock movements for the window, and what the old system holds of them. */
  readonly newSystemFacts: RollbackWindowFacts;
  readonly legacyFacts: RollbackWindowFacts;
  readonly stores: readonly StoreSyncedThrough[];
  readonly by: string;
  readonly at: string;
}): { readonly ok: true; readonly reconciliation: RollbackReconciliation } | { readonly ok: false; readonly refusal: RollbackReconciliationRefusal; readonly detail: string } {
  const r = input.rollback;
  if (!r.performed || r.state !== 'performed' || r.execution === undefined) {
    return { ok: false, refusal: 'not_performed', detail: `the rollback of ${r.cutoverId} is not performed yet — reconcile it once the old system has been seen taking sales` };
  }
  const to = r.execution.legacyTradingFrom;
  if (Number.isNaN(Date.parse(input.windowFrom))) return { ok: false, refusal: 'not_a_time', detail: 'when the new system started taking sales must be a time' };
  if (Date.parse(input.windowFrom) >= Date.parse(to)) {
    return { ok: false, refusal: 'window_after_switch_back', detail: `the new system's start ${input.windowFrom} is not before the switch-back at ${to}` };
  }
  if (input.stores.length === 0) {
    return { ok: false, refusal: 'no_store_sync_report', detail: 'no store computer has reported how far its sales have synced, so head office cannot know it holds every sale the new system took' };
  }
  const behind = input.stores.filter((s) => s.completeThrough === null || Date.parse(s.completeThrough) < Date.parse(to));
  if (behind.length > 0) {
    return {
      ok: false, refusal: 'store_not_synced_through_switch_back',
      detail: `${behind.map((s) => `${s.storeId} (complete only up to ${s.completeThrough ?? 'never'})`).join(', ')} has not synced past the switch-back at ${to} — sales it took on the new system may still be on its disk. Get it online, let it sync, then reconcile`,
    };
  }
  const differences: string[] = [];
  if (input.newSystem.count !== input.legacy.count) differences.push(`bills: the new system took ${input.newSystem.count}, the old system holds ${input.legacy.count}`);
  if (input.newSystem.totalMinor !== input.legacy.totalMinor) differences.push(`takings: the new system took ${input.newSystem.totalMinor} paise, the old system holds ${input.legacy.totalMinor}`);
  // OB-50: refunds (count and value) and every product's stock movement, each difference named.
  const nf = input.newSystemFacts; const lf = input.legacyFacts;
  if (nf.refunds.count !== lf.refunds.count) differences.push(`refunds: the new system gave ${nf.refunds.count}, the old system holds ${lf.refunds.count}`);
  if (nf.refunds.totalMinor !== lf.refunds.totalMinor) differences.push(`refund value: the new system refunded ${nf.refunds.totalMinor} paise, the old system holds ${lf.refunds.totalMinor}`);
  const ours = new Map(nf.stockMovements.map((m) => [m.productId, m.netQuantityMinor]));
  const theirs = new Map(lf.stockMovements.map((m) => [m.productId, m.netQuantityMinor]));
  for (const productId of [...new Set([...ours.keys(), ...theirs.keys()])].sort()) {
    const a = ours.get(productId) ?? 0; const b = theirs.get(productId) ?? 0;
    if (a !== b) differences.push(`stock of ${productId}: the new system moved ${a} on hand, the old system holds ${b}`);
  }
  const reconciled = differences.length === 0;
  return {
    ok: true,
    reconciliation: {
      cutoverId: r.cutoverId, decidedAt: r.decidedAt, windowFrom: input.windowFrom, windowTo: to,
      newSystem: input.newSystem, legacy: input.legacy, newSystemFacts: input.newSystemFacts, legacyFacts: input.legacyFacts, stores: input.stores, reconciled, differences,
      by: input.by, at: input.at,
      detail: reconciled
        ? `rollback of ${r.cutoverId} reconciled: ${input.newSystem.count} bill(s), ${input.newSystem.totalMinor} paise, ${nf.refunds.count} refund(s) of ${nf.refunds.totalMinor} paise and the stock movements of ${nf.stockMovements.length} product(s) on the new system between ${input.windowFrom} and ${to} are all in the old system; every store had synced past the switch-back`
        : `rollback of ${r.cutoverId} does NOT reconcile — ${differences.join('; ')}. It is not demonstrated until it does`,
    },
  };
}
