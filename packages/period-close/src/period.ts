// Period close, control totals and CA-signable evidence (M23-FR-04 / QG-07 / §28).
//
// A period close is the moment the shop says, in writing, "this is what happened last
// month" — and then a chartered accountant puts their name to it. The roadmap's
// acceptance is exactly that: **a CA can sign the control totals.** Which means the
// close cannot be a button that sets a flag.
//
// Three refusals, and each one is a month somebody else spent unpicking:
//
//   • **THE PERIOD CANNOT CLOSE ON UNVALIDATED CONTROL TOTALS** (QG-07). Every total is
//     computed twice, from two independent sides — what our ledger holds, and what was
//     actually posted to the accounts — and they must agree **exactly**, to the paisa.
//     A close that tolerates a small difference is a close that tolerates any
//     difference, because nobody ever tightens the tolerance afterwards.
//
//   • **THE PERIOD CANNOT CLOSE OVER UNFINISHED WORK.** A dead-lettered posting is money
//     the accounts have never seen. Unsent sync items are sales the cloud does not know
//     about. Open exceptions are differences nobody has explained. Closing over any of
//     them produces a signed set of accounts that is quietly wrong, and the signature
//     makes it worse rather than better.
//
//   • **A CLOSED PERIOD IS APPEND-ONLY.** Reopening needs an approval from someone other
//     than the person asking, and a correction to a closed period is a **compensating
//     entry dated in the open period** — never an edit to the closed one (hard rule #2).
//     The alternative is a set of accounts that changes after it was signed, which is
//     the one thing an auditor cannot forgive.
//
// The evidence pack is written for the person who signs it: every figure, where it came
// from, both sides of every comparison, and a single line saying whether it reconciles.
//
// Pure and deterministic: everything is passed in, including the clock.

export type PeriodState = 'open' | 'closed';

export interface ControlTotal {
  readonly name: string;
  /** What our own append-only ledger says. The book of record. */
  readonly ledgerMinor: number;
  /** What the accounts actually received. The independent second side. */
  readonly postedMinor: number;
  /** Where each side was computed from, so a CA can re-derive it. */
  readonly method: string;
}

export interface ControlTotalResult extends ControlTotal {
  readonly differenceMinor: number;
  readonly reconciles: boolean;
  readonly detail: string;
}

/** Compare both sides of every control total. Exact, in integer minor units (§29.1). */
export function validateControlTotals(
  totals: readonly ControlTotal[],
): { readonly results: readonly ControlTotalResult[]; readonly allReconcile: boolean } {
  const results = totals.map((t): ControlTotalResult => {
    const differenceMinor = t.postedMinor - t.ledgerMinor;
    return {
      ...t,
      differenceMinor,
      reconciles: differenceMinor === 0,
      detail:
        differenceMinor === 0
          ? `${t.name}: ${t.ledgerMinor} on both sides`
          : `${t.name}: the ledger says ${t.ledgerMinor}, the accounts received ${t.postedMinor} — a difference of ${differenceMinor} that must be explained before anyone signs`,
    };
  });
  return { results, allReconcile: results.every((r) => r.reconciles) };
}

export interface PeriodCloseInput {
  readonly period: string;
  readonly tenantId: string;
  readonly totals: readonly ControlTotal[];
  /** Postings Tally never accepted. Any at all blocks the close. */
  readonly deadLetteredCount: number;
  /** Sales the cloud has not received. Any at all blocks the close. */
  readonly unsentSyncCount: number;
  /** Differences nobody has explained yet. */
  readonly openExceptionCount: number;
  /** The trading-day cut-off this period aligns to (M01-FR-02). */
  readonly tradingDayCutoff: string;
  readonly closedBy: string;
  readonly at: string;
}

export type CloseBlocker =
  | 'control_totals_do_not_reconcile'
  | 'dead_lettered_postings'
  | 'unsent_sync_items'
  | 'open_exceptions'
  | 'already_closed';

export interface PeriodCloseResult {
  readonly period: string;
  readonly closed: boolean;
  /** **Every** blocker, not the first — so the finance team can plan one day's work. */
  readonly blockers: readonly { readonly kind: CloseBlocker; readonly detail: string }[];
  readonly totals: readonly ControlTotalResult[];
  readonly detail: string;
  readonly closedAt?: string;
}

/**
 * Close a period. Returns **every** blocker at once rather than one per attempt: a
 * finance team meeting obstacles one at a time on the last day of the month starts
 * looking for a way round the system, and finds one.
 */
export function closePeriod(
  input: PeriodCloseInput,
  currentState: PeriodState = 'open',
): PeriodCloseResult {
  const { results, allReconcile } = validateControlTotals(input.totals);
  const blockers: { kind: CloseBlocker; detail: string }[] = [];

  if (currentState === 'closed') {
    blockers.push({ kind: 'already_closed', detail: `period ${input.period} is already closed` });
  }
  if (!allReconcile) {
    const broken = results.filter((r) => !r.reconciles);
    blockers.push({
      kind: 'control_totals_do_not_reconcile',
      detail: `${broken.length} control total(s) do not reconcile: ${broken.map((b) => b.name).join(', ')}. A close that tolerates a small difference tolerates any difference`,
    });
  }
  if (input.deadLetteredCount > 0) {
    blockers.push({
      kind: 'dead_lettered_postings',
      detail: `${input.deadLetteredCount} posting(s) the accounts never received — closing over them signs off a month the books have not seen`,
    });
  }
  if (input.unsentSyncCount > 0) {
    blockers.push({
      kind: 'unsent_sync_items',
      detail: `${input.unsentSyncCount} sale(s) still queued at the edge — the period would close without them and they would arrive into a closed period`,
    });
  }
  if (input.openExceptionCount > 0) {
    blockers.push({
      kind: 'open_exceptions',
      detail: `${input.openExceptionCount} unexplained difference(s) — an exception closed by the calendar is not an exception explained`,
    });
  }

  if (blockers.length > 0) {
    return {
      period: input.period,
      closed: false,
      blockers,
      totals: results,
      detail: `period ${input.period} cannot close: ${blockers.length} blocker(s)`,
    };
  }

  return {
    period: input.period,
    closed: true,
    blockers: [],
    totals: results,
    closedAt: input.at,
    detail: `period ${input.period} closed by ${input.closedBy}; every control total reconciles exactly`,
  };
}

export interface ReopenApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
  readonly reason: string;
}

export interface ReopenResult {
  readonly reopened: boolean;
  readonly detail: string;
  readonly state: PeriodState;
}

/**
 * Reopen a closed period. Needs an approval by **someone other than the requester**
 * (§28) and a written reason — reopening a signed period is a decision with a name on
 * it, and the audit trail must be able to say whose.
 */
export function reopenPeriod(input: {
  readonly period: string;
  readonly requestedBy: string;
  readonly approval?: ReopenApproval;
  readonly at: string;
  readonly currentState?: PeriodState;
}): ReopenResult {
  if ((input.currentState ?? 'closed') !== 'closed') {
    return { reopened: false, detail: `period ${input.period} is not closed`, state: 'open' };
  }
  const a = input.approval;
  if (a === undefined || a.status !== 'approved' || a.subjectRef !== input.period) {
    return {
      reopened: false,
      detail: 'reopening a closed period needs an approval — a signed set of accounts does not change on one person\'s say-so',
      state: 'closed',
    };
  }
  if (a.decidedBy === input.requestedBy) {
    return {
      reopened: false,
      detail: 'the person asking to reopen the period cannot be the one who approves it (§28)',
      state: 'closed',
    };
  }
  if (a.reason.trim() === '') {
    return { reopened: false, detail: 'a reopen needs a written reason', state: 'closed' };
  }

  return {
    reopened: true,
    detail: `period ${input.period} reopened by ${input.requestedBy}, approved by ${a.decidedBy}: ${a.reason}`,
    state: 'open',
  };
}

export interface CorrectionRouting {
  readonly allowed: boolean;
  /** The period the correcting entry is actually dated in. */
  readonly postToPeriod: string;
  readonly detail: string;
}

/**
 * Where a correction for a closed period actually goes. It goes in the **open** period
 * as a compensating entry (hard rule #2) — never back into the closed one. Accounts
 * that change after they were signed are the one thing an auditor cannot forgive, and
 * the fix always looks harmless at the time.
 */
export function routeCorrection(input: {
  readonly forPeriod: string;
  readonly forPeriodState: PeriodState;
  readonly openPeriod: string;
}): CorrectionRouting {
  if (input.forPeriodState === 'open') {
    return {
      allowed: true,
      postToPeriod: input.forPeriod,
      detail: `${input.forPeriod} is open — the correction posts to the period it belongs to`,
    };
  }
  return {
    allowed: true,
    postToPeriod: input.openPeriod,
    detail: `${input.forPeriod} is closed, so the correction posts to ${input.openPeriod} as a compensating entry referencing it — a signed period is never edited`,
  };
}

export interface EvidencePack {
  readonly period: string;
  readonly tenantId: string;
  readonly preparedBy: string;
  readonly preparedAt: string;
  readonly tradingDayCutoff: string;
  readonly totals: readonly ControlTotalResult[];
  readonly reconciles: boolean;
  /** The one line the CA reads first. */
  readonly verdict: string;
  /** Plain-English lines, in signing order. */
  readonly statement: readonly string[];
  readonly signable: boolean;
}

/**
 * The pack the CA actually signs. It states **both sides of every figure and where each
 * came from**, so the signature is on something re-derivable rather than on our word.
 *
 * A pack that does not reconcile is still produced — hiding it would just mean the
 * conversation happens later — but it is marked **not signable**, and says why.
 */
export function buildEvidencePack(input: {
  readonly period: string;
  readonly tenantId: string;
  readonly totals: readonly ControlTotal[];
  readonly tradingDayCutoff: string;
  readonly preparedBy: string;
  readonly at: string;
  readonly deadLetteredCount?: number;
}): EvidencePack {
  const { results, allReconcile } = validateControlTotals(input.totals);
  const dead = input.deadLetteredCount ?? 0;
  const signable = allReconcile && dead === 0;

  const statement: string[] = [
    `Period ${input.period}, aligned to the trading-day cut-off of ${input.tradingDayCutoff}.`,
    `Prepared by ${input.preparedBy} on ${input.at}.`,
    'Each figure below is stated twice: what the append-only sales and stock ledger holds, and what the accounting system actually received. They are computed independently and must agree exactly.',
    ...results.map((r) => `${r.detail} (${r.method})`),
  ];
  if (dead > 0) {
    statement.push(
      `${dead} posting(s) never reached the accounts and are held in the dead-letter queue. They are listed in full and none has been discarded.`,
    );
  }
  statement.push(
    signable
      ? 'Every control total reconciles exactly and no posting is outstanding. These accounts are complete for the period.'
      : 'These accounts are NOT complete for the period. Do not sign them until the differences above are explained.',
  );

  return {
    period: input.period,
    tenantId: input.tenantId,
    preparedBy: input.preparedBy,
    preparedAt: input.at,
    tradingDayCutoff: input.tradingDayCutoff,
    totals: results,
    reconciles: allReconcile,
    verdict: signable
      ? `${input.period} reconciles exactly on every control total — signable`
      : `${input.period} does not reconcile — NOT signable`,
    statement,
    signable,
  };
}
