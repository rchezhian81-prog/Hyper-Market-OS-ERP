// API-09 Finance — journals, AP/AR, reconciliation, period close, Tally.
//
// **A closed period is closed.** That is the whole of this service's character. Once a period is
// closed and its control totals signed, nothing posts into it — not a late invoice, not a
// correction, not an adjustment somebody is sure is right. A late document goes to the next open
// period carrying the date it actually belongs to, so the accounts stay reconstructable and the
// signed figures stay the signed figures (hard rule #2, QG-07).
//
// The reason is not tidiness. A period that can be reopened quietly is a period whose signed
// numbers can change after the CA has signed them and after the return has been filed — and
// nobody downstream can tell that they did.
//
// Reopening is possible, deliberately: refusing it entirely would force somebody to find a worse
// way. It needs the owner, a reason, and it is itself an event on the record.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { reopenPeriod, type ReopenApproval } from '../../../packages/period-close/src/index';

export interface JournalLine {
  readonly accountCode: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface JournalEntry {
  readonly entryId: string;
  readonly period: string;
  /** The date the thing happened, which is not always in the period it posts to. */
  readonly documentDate: string;
  readonly narrative: string;
  readonly lines: readonly JournalLine[];
  readonly postedBy: string;
}

export type PeriodState = 'open' | 'closed';

export type PostRefusal =
  | 'period_is_closed'
  | 'entry_does_not_balance'
  | 'no_narrative'
  | 'control_totals_not_signed';

export interface PostResult {
  readonly ok: boolean;
  readonly postedTo?: string;
  readonly refusedBecause?: PostRefusal;
  readonly detail: string;
  readonly ownerAction?: string;
}

/** Post a journal, or refuse — and when the period is closed, say where it should go instead. */
export function postJournal(input: {
  readonly entry: JournalEntry;
  readonly periodStates: ReadonlyMap<string, PeriodState>;
  readonly nextOpenPeriod: string;
}): PostResult {
  const { entry } = input;

  const balance = entry.lines.reduce((t, l) => t + l.debitMinor - l.creditMinor, 0);
  if (balance !== 0) {
    return {
      ok: false, refusedBecause: 'entry_does_not_balance',
      detail: `the entry is out by ${balance}. A journal that does not balance cannot be posted anywhere — it would carry the difference into the accounts permanently`,
    };
  }
  if (entry.narrative.trim().length < 10) {
    return {
      ok: false, refusedBecause: 'no_narrative',
      detail: 'a journal with no narrative is a figure nobody can account for at the audit. It is the one field that is read years later',
    };
  }

  if (input.periodStates.get(entry.period) === 'closed') {
    return {
      ok: false, refusedBecause: 'period_is_closed',
      detail: `${entry.period} is closed and its figures are signed. Posting into it would change numbers the CA has already signed and a return has already been filed against, with nothing downstream able to tell that they changed`,
      ownerAction: `Post it to ${input.nextOpenPeriod} carrying its real document date of ${entry.documentDate}. The accounts stay reconstructable and the signed period stays as signed.`,
    };
  }

  return { ok: true, postedTo: entry.period, detail: `${entry.entryId} posted to ${entry.period}` };
}

export interface ControlTotalCheck {
  readonly name: string;
  readonly leftMinor: number;
  readonly rightMinor: number;
  readonly leftDerivation: string;
  readonly rightDerivation: string;
}

export type CloseRefusal =
  | 'nothing_was_checked'
  | 'control_total_does_not_agree'
  | 'both_sides_from_the_same_place'
  | 'closed_by_whoever_posted'
  | 'not_signed';

export interface CloseResult {
  readonly ok: boolean;
  readonly refusedBecause?: CloseRefusal;
  readonly detail: string;
}

/**
 * Close a period, or refuse.
 *
 * The second refusal is the one that matters and it is the same control MG-06 applies: two totals
 * computed the same way agree perfectly and prove nothing. "Sum of the sales ledger" against "sum
 * of the sales ledger" is arithmetic, not a check.
 */
export function closePeriod(input: {
  readonly period: string;
  readonly checks: readonly ControlTotalCheck[];
  readonly closedBy: string;
  readonly postedBy: readonly string[];
  readonly signedBy?: string;
}): CloseResult {
  // Nothing to check is not the same as everything agreeing.
  //
  // The loop below is vacuously satisfied by an empty list, so a period with no control total at
  // all closed on a signature alone — and then reported "0 control total(s) agreed", which is a
  // sentence that reads like success. Zero agreements is silence, not agreement. It is the same
  // fault the second refusal exists to catch, arrived at by subtraction instead of by circularity.
  if (input.checks.length === 0) {
    return {
      ok: false, refusedBecause: 'nothing_was_checked',
      detail: `no control total was presented for ${input.period}, so closing it would sign off a month that nothing has checked. Two figures from two different places have to agree before a period is signed (QG-07)`,
    };
  }

  for (const c of input.checks) {
    if (c.leftDerivation.trim().toLowerCase() === c.rightDerivation.trim().toLowerCase()) {
      return {
        ok: false, refusedBecause: 'both_sides_from_the_same_place',
        detail: `"${c.name}" compares ${c.leftDerivation} against itself. Two totals computed the same way agree perfectly and prove nothing — they would agree just as perfectly about a wrong number (QG-07)`,
      };
    }
    if (c.leftMinor !== c.rightMinor) {
      return {
        ok: false, refusedBecause: 'control_total_does_not_agree',
        detail: `"${c.name}": ${c.leftDerivation} gives ${c.leftMinor} and ${c.rightDerivation} gives ${c.rightMinor}, a difference of ${c.rightMinor - c.leftMinor}`,
      };
    }
  }
  if (input.signedBy === undefined) {
    return { ok: false, refusedBecause: 'not_signed', detail: `${input.period} reconciles and nobody has signed it (QG-07)` };
  }
  if (input.postedBy.includes(input.signedBy)) {
    return {
      ok: false, refusedBecause: 'closed_by_whoever_posted',
      detail: `${input.signedBy} posted into ${input.period} and cannot also certify that it is right`,
    };
  }
  return { ok: true, detail: `${input.period} closed, ${input.checks.length} control total(s) agreed, signed by ${input.signedBy}` };
}

export interface FinanceDeps {
  readonly periodStates: (tenantId: string) => Promise<ReadonlyMap<string, PeriodState>> | ReadonlyMap<string, PeriodState>;
  readonly nextOpenPeriod: (tenantId: string) => Promise<string> | string;
  readonly appendJournal: (tenantId: string, e: JournalEntry) => Promise<void> | void;
  readonly controlTotals: (tenantId: string, period: string) => Promise<readonly ControlTotalCheck[]> | readonly ControlTotalCheck[];
  readonly postersIn: (tenantId: string, period: string) => Promise<readonly string[]> | readonly string[];
  readonly markClosed: (tenantId: string, period: string, signedBy: string) => Promise<void> | void;
  /** Reopen a closed period as a NEW append-only fact (never an edit) — the period becomes re-closable. */
  readonly markReopened: (tenantId: string, period: string, reopen: { readonly requestedBy: string; readonly approvedBy: string; readonly reason: string }) => Promise<void> | void;
  readonly now: () => string;
}

export function financeRoutes(deps: FinanceDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/journals',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const entry = ctx.body as JournalEntry;
        const result = postJournal({
          entry,
          periodStates: await deps.periodStates(ctx.tenantId),
          nextOpenPeriod: await deps.nextOpenPeriod(ctx.tenantId),
        });
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: result.ownerAction ?? 'Nothing was posted. Correct the entry and send it again.',
          });
        }
        await deps.appendJournal(ctx.tenantId, entry);
        return { status: 201, body: { entryId: entry.entryId, postedTo: result.postedTo } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/periods/:period/close',
      permission: 'finance.period.close', idempotent: true,
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        const body = (ctx.body ?? {}) as { signedBy?: string };
        // A period is not closed twice. If figures changed after signing, it is REOPENED (with a second
        // person's approval), never silently re-closed over the top of the signed set.
        if ((await deps.periodStates(ctx.tenantId)).get(period) === 'closed') {
          throw apiError(409, {
            code: 'already_closed',
            whatHappened: `${period} is already closed and signed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: `To change a signed period, reopen ${period} with a second person's approval, or post a correction to the open period. Nothing was changed.`,
          });
        }
        const result = closePeriod({
          period,
          checks: await deps.controlTotals(ctx.tenantId, period),
          closedBy: ctx.userId,
          postedBy: await deps.postersIn(ctx.tenantId, period),
          ...(body.signedBy === undefined ? {} : { signedBy: body.signedBy }),
        });
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The period is still open and everything in it is unchanged. Settle what is named above, then close it.',
          });
        }
        await deps.markClosed(ctx.tenantId, period, body.signedBy!);
        return { status: 200, body: { closed: result.detail } };
      },
    },
    {
      // Reopen a signed period (M23-FR-04 / §28). A closed period does not change on one person's say-so:
      // reopening needs an approval by SOMEONE OTHER THAN the requester and a written reason. It is recorded
      // as a NEW append-only fact (never an edit to the closed period — hard rule #2), and the period becomes
      // open and re-closable. Corrections to what it held still post to the open period (see postJournal).
      api: 'API-09', method: 'POST', path: '/v1/finance/periods/:period/reopen',
      permission: 'finance.period.close', idempotent: true,
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        const b = (ctx.body ?? {}) as { approvedBy?: unknown; reason?: unknown };
        if (typeof b.approvedBy !== 'string' || b.approvedBy.trim() === '' || typeof b.reason !== 'string' || b.reason.trim() === '') {
          throw apiError(400, {
            code: 'reopen_needs_approver_and_reason',
            whatHappened: 'Reopening a closed period needs { approvedBy } — a different person who approves it (§28) — and a written { reason }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send who approves the reopen and why. Nothing was changed.',
          });
        }
        const currentState = (await deps.periodStates(ctx.tenantId)).get(period) ?? 'open';
        const approval: ReopenApproval = { subjectRef: period, status: 'approved', decidedBy: b.approvedBy.trim(), reason: b.reason.trim() };
        const result = reopenPeriod({ period, requestedBy: ctx.userId, approval, at: deps.now(), currentState });
        if (!result.reopened) {
          // not-closed / self-approval — the engine's reason, verbatim.
          throw apiError(422, {
            code: 'reopen_refused',
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'A signed period reopens only with a DIFFERENT person’s approval and a reason; an already-open period has nothing to reopen. Nothing was changed.',
          });
        }
        await deps.markReopened(ctx.tenantId, period, { requestedBy: ctx.userId, approvedBy: approval.decidedBy, reason: approval.reason });
        return { status: 200, body: { period, state: result.state, reopenedBy: ctx.userId, approvedBy: approval.decidedBy, detail: result.detail } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/periods',
      permission: 'finance.period.read',
      handler: async (ctx) => ({
        status: 200,
        body: { periods: [...(await deps.periodStates(ctx.tenantId))].map(([period, state]) => ({ period, state })), asAt: deps.now() },
      }),
    },
  ];
}
