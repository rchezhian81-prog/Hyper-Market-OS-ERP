// Finance — control totals, the Tally queue, and the month close (M23-FR-01…04 · QG-07 · §28 · P-08).
//
// The roadmap's acceptance for this module is one sentence: **a CA can sign the control totals.**
// Not "the system closes the period" — a named professional puts their name to a set of figures and
// is accountable for them afterwards.
//
// ── What was here, and what was missing ─────────────────────────────────────
//
// `validateControlTotals` compares both sides exactly. `closePeriod` returns **every** blocker at
// once rather than one per attempt, because a finance team meeting obstacles one at a time on the
// last day of the month starts looking for a way round the system and finds one. `buildEvidencePack`
// writes the pack for the person signing it. All three were written, tested — and **never given a
// control total**, because nothing in this system built one. The gap analysis has said so plainly
// for weeks: *no month can close yet.*
//
// `packages/period-close/src/control-totals.ts` is that producer. This surface is where a person
// uses it.
//
// ── The rule the whole screen turns on ──────────────────────────────────────
//
// **Only a posting the accounts have actually accepted counts as received.** A posting in the queue
// is money Tally has never seen; a dead-lettered one is money Tally refused. Counting either would
// make both sides agree — the same number computed twice — and the month would close, reconciled
// and signed, with the accounts missing the lot.
//
// So the queue is reported **beside** the totals and never inside them, and a dead-lettered posting
// blocks the close outright. Nothing here can discard one (hard rule #6).
//
// ── And the one that follows ────────────────────────────────────────────────
//
// **A closed period is append-only.** Reopening needs a different person's approval, and a
// correction to a closed month is a compensating entry dated in the open one — never an edit. A set
// of accounts that changes after it was signed is the one thing an auditor cannot forgive.

import {
  buildControlTotals, postedSide, validateControlTotals, closePeriod, reopenPeriod,
  buildEvidencePack, deadLetters,
  type ControlTotal, type ControlTotalResult, type EvidencePack, type LedgerSide,
  type PeriodCloseResult, type PostedSide, type QueuedPosting,
} from '../../../packages/period-close/src/index';

/** What finance can see, and what it honestly cannot. */
export interface FinancePorts {
  /** What the shop's own append-only record says happened in the period. */
  ledger(): LedgerSide | undefined;
  /** Every posting for the period, in whatever state it reached. */
  postings(): readonly QueuedPosting[];
  /** Whether this period is already closed, and by whom. */
  periodState(): { readonly closed: boolean; readonly closedBy?: string; readonly closedAt?: string };
  /** Sales the cloud has not received. Any at all blocks the close. */
  unsentSyncCount(): number;
  /** Differences nobody has explained yet. */
  openExceptionCount(): number;
}

export interface FinanceConfig {
  readonly tenantId: string;
  /** The month being closed, e.g. "2026-07". */
  readonly period: string;
  /** Who is looking. `null` means the box was not told — nothing may be closed under no name. */
  readonly userId: string | null;
  readonly now: string;
  /** The trading-day cut-off this period aligns to (M01-FR-02 / A-13). */
  readonly tradingDayCutoff: string;
  /**
   * Which journal references belong to which figure — this shop's own chart of accounts.
   *
   * Never a constant. A mapping guessed here would file a shop's takings under a heading its
   * accountant does not use, and the difference would surface as an unexplained control total.
   */
  readonly journalPrefixes: Readonly<Record<'takings' | 'tax' | 'refunds', string>>;
}

export type CloseRefusal =
  | 'nobody_is_named_at_this_desk'
  | 'the_shop_has_not_told_us_what_it_took'
  | 'blocked';

export type ReopenRefusal =
  | 'nobody_is_named_at_this_desk'
  | 'not_closed'
  | 'needs_a_different_person'
  | 'needs_a_reason';

const CLOSE_REFUSAL_VALUES: Readonly<Record<CloseRefusal, CloseRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  the_shop_has_not_told_us_what_it_took: 'the_shop_has_not_told_us_what_it_took',
  blocked: 'blocked',
});
export const CLOSE_REFUSAL_KINDS: readonly CloseRefusal[] = Object.freeze(Object.values(CLOSE_REFUSAL_VALUES));

const REOPEN_REFUSAL_VALUES: Readonly<Record<ReopenRefusal, ReopenRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  not_closed: 'not_closed',
  needs_a_different_person: 'needs_a_different_person',
  needs_a_reason: 'needs_a_reason',
});
export const REOPEN_REFUSAL_KINDS: readonly ReopenRefusal[] = Object.freeze(Object.values(REOPEN_REFUSAL_VALUES));

/** The month as finance sees it: both sides of every figure, and what is still outstanding. */
export interface PeriodView {
  readonly period: string;
  /**
   * Both sides of every control total, or `undefined` when **the shop has not said what it took**.
   *
   * Not an empty list. An empty list of totals reconciles vacuously — nothing disagreed because
   * nothing was compared — and that is precisely how a month closes on nothing at all.
   */
  readonly totals: readonly ControlTotalResult[] | undefined;
  readonly whyNoTotals?: string;
  readonly allReconcile: boolean;
  /** The queue, reported beside the totals and never inside them. */
  readonly posted: PostedSide;
  /** Every dead-lettered posting, in full. Never summarised away, never discarded. */
  readonly deadLettered: readonly QueuedPosting[];
  readonly unsentSyncCount: number;
  readonly openExceptionCount: number;
  readonly closed: boolean;
  readonly closedBy?: string;
  readonly closedAt?: string;
}

export type CloseOutcome =
  | { readonly ok: true; readonly result: PeriodCloseResult }
  | { readonly ok: false; readonly refusal: CloseRefusal; readonly detail: string; readonly result?: PeriodCloseResult };

export type ReopenOutcome =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly refusal: ReopenRefusal; readonly detail: string };

export interface FinanceSession {
  /** The month, both sides of every figure, and what is outstanding. */
  period(): PeriodView;
  /** The pack a CA signs — or the same pack marked NOT signable, saying why. */
  evidence(): EvidencePack | { readonly signable: false; readonly why: string };
  /** Try to close. Returns every blocker at once. */
  close(): CloseOutcome;
  /** Reopen a closed month — a different person's approval, and a reason. */
  reopen(input: { readonly reason: string; readonly approvedBy: string }): ReopenOutcome;
}

export function createFinanceSession(config: FinanceConfig, ports: FinancePorts): FinanceSession {
  const NO_LEDGER =
    'this store box has not told finance what the shop took in this period, so there is nothing to check the accounts against. A month cannot close on one side of a comparison.';

  const totalsNow = (): readonly ControlTotal[] | undefined => {
    const ledger = ports.ledger();
    if (ledger === undefined) return undefined;
    return buildControlTotals({
      period: config.period,
      ledger,
      postings: ports.postings(),
      journalPrefixes: config.journalPrefixes,
    });
  };

  const view = (): PeriodView => {
    const built = totalsNow();
    const state = ports.periodState();
    const postings = ports.postings();
    const validated = built === undefined ? undefined : validateControlTotals(built);
    return {
      period: config.period,
      totals: validated?.results,
      ...(built === undefined ? { whyNoTotals: NO_LEDGER } : {}),
      // **Not true when there are no totals.** "Everything reconciles" about nothing is the
      // sentence this whole module exists to prevent.
      allReconcile: validated?.allReconcile ?? false,
      posted: postedSide(postings),
      deadLettered: deadLetters(postings),
      unsentSyncCount: ports.unsentSyncCount(),
      openExceptionCount: ports.openExceptionCount(),
      closed: state.closed,
      ...(state.closedBy === undefined ? {} : { closedBy: state.closedBy }),
      ...(state.closedAt === undefined ? {} : { closedAt: state.closedAt }),
    };
  };

  return {
    period: view,

    evidence: () => {
      const built = totalsNow();
      if (built === undefined) return { signable: false, why: NO_LEDGER };
      return buildEvidencePack({
        period: config.period,
        tenantId: config.tenantId,
        totals: built,
        tradingDayCutoff: config.tradingDayCutoff,
        // The pack names who prepared it. An unnamed pack is one nobody can be asked about.
        preparedBy: config.userId ?? 'nobody named',
        at: config.now,
        deadLetteredCount: deadLetters(ports.postings()).length,
      });
    },

    close: () => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: CLOSE_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen. A month close carries the name of whoever closed it, and a CA signs after them.',
        };
      }
      const built = totalsNow();
      if (built === undefined) {
        // The refusal that matters most, and the one an empty list would have hidden: with no
        // ledger side there is nothing to compare, and `closePeriod` over an empty list of totals
        // would find nothing that disagrees and close the month.
        return {
          ok: false,
          refusal: CLOSE_REFUSAL_VALUES.the_shop_has_not_told_us_what_it_took,
          detail: NO_LEDGER,
        };
      }

      const postings = ports.postings();
      const result = closePeriod(
        {
          period: config.period,
          tenantId: config.tenantId,
          totals: built,
          deadLetteredCount: deadLetters(postings).length,
          unsentSyncCount: ports.unsentSyncCount(),
          openExceptionCount: ports.openExceptionCount(),
          tradingDayCutoff: config.tradingDayCutoff,
          closedBy: config.userId,
          at: config.now,
        },
        ports.periodState().closed ? 'closed' : 'open',
      );

      return result.closed
        ? { ok: true, result }
        : { ok: false, refusal: CLOSE_REFUSAL_VALUES.blocked, detail: result.detail, result };
    },

    reopen: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: REOPEN_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen.',
        };
      }
      if (!ports.periodState().closed) {
        return {
          ok: false,
          refusal: REOPEN_REFUSAL_VALUES.not_closed,
          detail: `period ${config.period} is not closed, so there is nothing to reopen.`,
        };
      }
      if (input.reason.trim() === '') {
        return {
          ok: false,
          refusal: REOPEN_REFUSAL_VALUES.needs_a_reason,
          detail: 'reopening a signed month needs a reason. It is the first thing an auditor asks.',
        };
      }
      // Separation of duties, checked HERE as well as in the domain, because the domain's own
      // check is on the approval record and this one is on the person in front of the screen.
      if (input.approvedBy === config.userId) {
        return {
          ok: false,
          refusal: REOPEN_REFUSAL_VALUES.needs_a_different_person,
          detail: 'the person reopening a month cannot be the person approving it (§28).',
        };
      }

      const outcome = reopenPeriod({
        period: config.period,
        requestedBy: config.userId,
        approval: {
          subjectRef: config.period,
          status: 'approved',
          decidedBy: input.approvedBy,
          reason: input.reason,
        },
        at: config.now,
        currentState: 'closed',
      });
      return outcome.reopened
        ? { ok: true, detail: outcome.detail }
        : { ok: false, refusal: REOPEN_REFUSAL_VALUES.needs_a_different_person, detail: outcome.detail };
    },
  };
}
