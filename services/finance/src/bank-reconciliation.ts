// API-09 Finance — BANK RECONCILIATION, line by line (U6 · M23-FR-03 · QG-07 · P-08 · hard rule #10; UI/UX gap audit lane 3:
// "Finance · bank/gateway reconciliation — MISSING (bank)").
//
// A bank statement is imported as independent evidence (`independent-evidence.ts`), and the month's control totals compare
// it with the books in the aggregate. This is the accountant's line-by-line view the M23-FR-03 flow asks for — "import
// bank statements → match to POS tenders and refunds → flag exceptions with value; an unmatched line is an exception,
// resolved same day":
//   • every line of a statement is MATCHED to what the books know — a credit that names a provider payout batch (the
//     same rule the close uses), a credit that names a recorded cash-deposit slip for the same amount (the deposit views
//     already paired it) — or it is UNMATCHED, with its value, never folded into a total;
//   • an unmatched line becomes an EXCEPTION a named person owns, raised by a person, with its value (the contract's
//     `ReconciliationExceptionRaised`, §30.2), and is RESOLVED with an outcome and a reason, by a person
//     (`ReconciliationExceptionResolved`) — both append-only facts; a resolution never edits the line or the statement;
//   • "resolved same day" (§34.1) is SAID, not enforced: an exception still open after the shop day it was raised on is
//     OVERDUE on the page (P-08) — the accountant decides, the system does not close it for them.
// Nothing here moves money or posts a journal; a hand-match records WHAT the person matched the line to (a bill, a
// supplier payment ref) so the books can follow — the posting itself stays with the day book and the payables.
// No card number, no account number: a statement line carries only the bank's reference and narrative (hard rule #3).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { BankStatement, BankStatementLine } from '../../../packages/finance/src/bank-statement';
import type { CashDepositView } from './cash-deposits';
import type { SettlementBatch } from './settlement';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { tradingDayIn } from '../../../packages/calendar/src/trading-day';

/** An exception raised on one statement line: who owns it, who raised it, when (the instant and the shop day), its value. */
export interface BankLineException {
  readonly exceptionId: string;
  readonly statementId: string;
  readonly lineId: string;
  /** The line's signed amount in paise — the exception's VALUE (M23-FR-03: "flag exceptions with value"). */
  readonly amountMinor: number;
  readonly ownerUserId: string;
  readonly raisedBy: string;
  readonly raisedAt: string;
  /** The shop day it was raised on — "resolved same day" is judged against this. */
  readonly raisedOn: string;
  readonly note?: string;
}

export const EXCEPTION_OUTCOMES = ['matched_by_hand', 'bank_error', 'not_ours', 'timing', 'other'] as const;
export type ExceptionOutcome = (typeof EXCEPTION_OUTCOMES)[number];

export interface BankLineExceptionResolved {
  readonly exceptionId: string;
  readonly outcome: ExceptionOutcome;
  readonly reason: string;
  /** What the person matched the line to by hand (a bill, a supplier payment, a slip) — kept so the books can follow. */
  readonly matchedTo?: string;
  readonly by: string;
  readonly at: string;
}

/** An exception with its state, as the page reads it. */
export interface BankLineExceptionView extends BankLineException {
  readonly state: 'open' | 'resolved';
  readonly overdue: boolean;
  readonly resolution?: BankLineExceptionResolved;
}

export type LineMatch =
  | { readonly kind: 'provider_payout'; readonly batchId: string; readonly providerId: string; readonly declaredNetMinor: number }
  | { readonly kind: 'cash_deposit'; readonly depositId: string; readonly slipRef: string }
  | { readonly kind: 'exception'; readonly exceptionId: string; readonly state: 'open' | 'resolved'; readonly overdue: boolean; readonly ownerUserId: string; readonly raisedOn: string; readonly outcome?: ExceptionOutcome; readonly matchedTo?: string; readonly reason?: string }
  | { readonly kind: 'unmatched' };

export interface ReconciledLine extends BankStatementLine { readonly match: LineMatch }

export interface StatementReconciliation {
  readonly statementId: string;
  readonly lines: readonly ReconciledLine[];
  readonly totals: {
    readonly lines: number; readonly creditsMinor: number; readonly debitsMinor: number;
    readonly matched: number; readonly matchedMinor: number;
    readonly unmatched: number; readonly unmatchedMinor: number;
    readonly openExceptions: number; readonly overdueExceptions: number; readonly resolvedExceptions: number;
  };
  /** The statement's own arithmetic: opening + every line = closing (it was refused at import otherwise; said again here). */
  readonly statementAddsUp: boolean;
}

/** Every raised exception with its state (resolved once a resolution names it) and whether it is overdue on `today`. Pure. */
export function exceptionViews(raised: readonly BankLineException[], resolved: readonly BankLineExceptionResolved[], today: string): readonly BankLineExceptionView[] {
  const byId = new Map<string, BankLineExceptionResolved>();
  for (const r of resolved) if (!byId.has(r.exceptionId)) byId.set(r.exceptionId, r); // the first resolution stands (append-only)
  const seen = new Set<string>();
  const out: BankLineExceptionView[] = [];
  for (const e of raised) {
    if (seen.has(e.exceptionId)) continue;
    seen.add(e.exceptionId);
    const resolution = byId.get(e.exceptionId);
    out.push({ ...e, state: resolution === undefined ? 'open' : 'resolved', overdue: resolution === undefined && today > e.raisedOn, ...(resolution === undefined ? {} : { resolution }) });
  }
  return out;
}

/** The statement's lines each matched to what the books know, or an exception, or unmatched — with the totals. Pure. */
export function reconcileBankStatement(input: {
  readonly statement: BankStatement;
  readonly batches: readonly SettlementBatch[];
  readonly deposits: readonly CashDepositView[];
  readonly exceptions: readonly BankLineExceptionView[];
}): StatementReconciliation {
  const s = input.statement;
  const depositByLine = new Map<string, CashDepositView>();
  for (const d of input.deposits) if (d.bankLine !== null && d.bankLine.statementId === s.statementId) depositByLine.set(d.bankLine.lineId, d);
  const exceptionByLine = new Map<string, BankLineExceptionView>();
  for (const e of input.exceptions) if (e.statementId === s.statementId && !exceptionByLine.has(e.lineId)) exceptionByLine.set(e.lineId, e);
  const names = (l: BankStatementLine, id: string): boolean => l.reference.includes(id) || (l.narrative ?? '').includes(id);
  const lines: ReconciledLine[] = s.lines.map((l) => {
    const batch = l.amountMinor > 0 ? input.batches.find((b) => names(l, b.batchId)) : undefined;
    if (batch !== undefined) return { ...l, match: { kind: 'provider_payout', batchId: batch.batchId, providerId: batch.providerId, declaredNetMinor: batch.declaredNetMinor } };
    const deposit = depositByLine.get(l.lineId);
    if (deposit !== undefined) return { ...l, match: { kind: 'cash_deposit', depositId: deposit.depositId, slipRef: deposit.slipRef } };
    const e = exceptionByLine.get(l.lineId);
    if (e !== undefined) {
      return { ...l, match: { kind: 'exception', exceptionId: e.exceptionId, state: e.state, overdue: e.overdue, ownerUserId: e.ownerUserId, raisedOn: e.raisedOn, ...(e.resolution === undefined ? {} : { outcome: e.resolution.outcome, reason: e.resolution.reason, ...(e.resolution.matchedTo === undefined ? {} : { matchedTo: e.resolution.matchedTo }) }) } };
    }
    return { ...l, match: { kind: 'unmatched' } };
  });
  const sum = (xs: readonly ReconciledLine[]): number => xs.reduce((n, l) => n + l.amountMinor, 0);
  const matched = lines.filter((l) => l.match.kind === 'provider_payout' || l.match.kind === 'cash_deposit');
  const unmatched = lines.filter((l) => l.match.kind === 'unmatched');
  const exceptions = lines.map((l) => l.match).filter((m): m is Extract<LineMatch, { kind: 'exception' }> => m.kind === 'exception');
  return {
    statementId: s.statementId, lines,
    totals: {
      lines: lines.length,
      creditsMinor: sum(lines.filter((l) => l.amountMinor > 0)), debitsMinor: sum(lines.filter((l) => l.amountMinor < 0)),
      matched: matched.length, matchedMinor: sum(matched), unmatched: unmatched.length, unmatchedMinor: sum(unmatched),
      openExceptions: exceptions.filter((e) => e.state === 'open').length, overdueExceptions: exceptions.filter((e) => e.overdue).length,
      resolvedExceptions: exceptions.filter((e) => e.state === 'resolved').length,
    },
    statementAddsUp: s.openingMinor + sum(lines) === s.closingMinor,
  };
}

export interface BankReconciliationDeps {
  readonly statements: (tenantId: string) => Promise<readonly BankStatement[]>;
  readonly batches: (tenantId: string) => Promise<readonly SettlementBatch[]>;
  readonly depositViews: (tenantId: string) => Promise<readonly CashDepositView[]>;
  readonly exceptionsRaised: (tenantId: string) => Promise<readonly BankLineException[]>;
  readonly exceptionsResolved: (tenantId: string) => Promise<readonly BankLineExceptionResolved[]>;
  readonly recordRaised: (tenantId: string, e: BankLineException) => Promise<void>;
  readonly recordResolved: (tenantId: string, r: BankLineExceptionResolved) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** R1b: the shop's calendar — "the day it was raised" is the shop's trading day, never the UTC date. */
  readonly calendar?: ShopCalendarOf;
  readonly now: () => string;
}

const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const summary = (s: BankStatement) => ({ statementId: s.statementId, accountRef: s.accountRef, fromDate: s.fromDate, toDate: s.toDate, openingMinor: s.openingMinor, closingMinor: s.closingMinor, lines: s.lines.length });

export function bankReconciliationRoutes(deps: BankReconciliationDeps): readonly Route[] {
  const shopDay = async (t: string, iso: string): Promise<string> => tradingDayIn(iso, await shopClock(deps.calendar).calendar(t));
  const views = async (t: string): Promise<readonly BankLineExceptionView[]> => {
    const [raised, resolved] = await Promise.all([deps.exceptionsRaised(t), deps.exceptionsResolved(t)]);
    return exceptionViews(raised, resolved, await shopDay(t, deps.now()));
  };
  return [
    {
      // The statement asked for (`?statementId=`), else the newest imported, every line matched or not; and the list of statements.
      api: 'API-09', method: 'GET', path: '/v1/finance/bank-reconciliation',
      permission: 'settlement.review.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const statements = await deps.statements(t);
        const asked = (ctx.query['statementId'] ?? '').trim();
        const statement = asked === '' ? [...statements].sort((a, b) => (a.toDate < b.toDate ? 1 : a.toDate > b.toDate ? -1 : 0))[0] : statements.find((s) => s.statementId === asked);
        if (asked !== '' && statement === undefined) {
          throw apiError(404, { code: 'statement_unknown', whatHappened: `No bank statement ${asked} has been imported.`, wasItSaved: 'not_saved', nextSafeAction: 'Choose a statement from the list, or import it on the Card, UPI and bank page. Nothing was changed.' });
        }
        const exceptions = await views(t);
        if (statement === undefined) {
          return { status: 200, body: { statements: [], statement: null, lines: [], totals: null, statementAddsUp: null, exceptions, asAt: deps.now() } };
        }
        const [batches, deposits] = await Promise.all([deps.batches(t), deps.depositViews(t)]);
        const r = reconcileBankStatement({ statement, batches, deposits, exceptions });
        return { status: 200, body: { statements: statements.map(summary), statement: summary(statement), ...r, exceptions: exceptions.filter((e) => e.statementId === statement.statementId), asAt: deps.now() } };
      },
    },
    {
      // Raise an exception on one unmatched line: its value is the line's, a named person owns it, the raiser is recorded.
      api: 'API-09', method: 'POST', path: '/v1/finance/bank-reconciliation/exceptions/:exceptionId',
      permission: 'settlement.investigation.manage', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const exceptionId = (ctx.params['exceptionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (exceptionId === '' || !isStr(b['statementId']) || !isStr(b['lineId']) || !isStr(b['ownerUserId']) || (b['note'] !== undefined && typeof b['note'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_bank_exception',
            whatHappened: 'A bank exception is { statementId, lineId, ownerUserId (the person who will see it through), note? }.',
            wasItSaved: 'not_saved', nextSafeAction: 'Choose the statement line and the person who owns it. Nothing was recorded.',
          });
        }
        const statementId = b['statementId'].trim(); const lineId = b['lineId'].trim(); const ownerUserId = b['ownerUserId'].trim();
        const note = typeof b['note'] === 'string' && b['note'].trim() !== '' ? b['note'].trim().slice(0, 300) : undefined;
        const statement = (await deps.statements(t)).find((s) => s.statementId === statementId);
        if (statement === undefined) throw apiError(404, { code: 'statement_unknown', whatHappened: `No bank statement ${statementId} has been imported.`, wasItSaved: 'not_saved', nextSafeAction: 'Choose a statement from the list. Nothing was recorded.' });
        const line = statement.lines.find((l) => l.lineId === lineId);
        if (line === undefined) throw apiError(404, { code: 'line_unknown', whatHappened: `Statement ${statementId} has no line ${lineId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Choose a line of the statement. Nothing was recorded.' });
        const prior = (await deps.exceptionsRaised(t)).find((e) => e.exceptionId === exceptionId);
        if (prior !== undefined) {
          if (prior.statementId === statementId && prior.lineId === lineId && prior.ownerUserId === ownerUserId) return { status: 200, body: { exception: prior, alreadyRaised: true } };
          throw apiError(409, { code: 'exception_id_used', whatHappened: `Exception ${exceptionId} is already raised on line ${prior.lineId} of ${prior.statementId}, owned by ${prior.ownerUserId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Raise the new exception under its own id. Nothing was changed.' });
        }
        const [batches, deposits, exceptions] = await Promise.all([deps.batches(t), deps.depositViews(t), views(t)]);
        const r = reconcileBankStatement({ statement, batches, deposits, exceptions });
        const matched = r.lines.find((l) => l.lineId === lineId)!.match;
        if (matched.kind === 'provider_payout' || matched.kind === 'cash_deposit') {
          throw apiError(409, {
            code: 'line_already_matched',
            whatHappened: `Line ${lineId} is already matched: ${matched.kind === 'provider_payout' ? `the provider payout ${matched.batchId}` : `cash deposit ${matched.depositId} (slip ${matched.slipRef})`}. A matched line needs no exception.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Raise an exception on an unmatched line only. Nothing was recorded.',
          });
        }
        if (matched.kind === 'exception') {
          throw apiError(409, {
            code: 'line_already_has_an_exception',
            whatHappened: `Line ${lineId} already carries exception ${matched.exceptionId} (${matched.state}, owned by ${matched.ownerUserId}).`,
            wasItSaved: 'not_saved', nextSafeAction: matched.state === 'open' ? 'Resolve that exception with a reason; one line carries one exception at a time. Nothing was recorded.' : 'That exception is resolved; if the line is still wrong, say so in a new exception under a new id after reading the resolution. Nothing was recorded.',
          });
        }
        const raisedAt = deps.now();
        const e: BankLineException = { exceptionId, statementId, lineId, amountMinor: line.amountMinor, ownerUserId, raisedBy: ctx.userId, raisedAt, raisedOn: await shopDay(t, raisedAt), ...(note === undefined ? {} : { note }) };
        await deps.recordRaised(t, e);
        await deps.recordAudit?.(t, {
          actorId: ctx.userId, action: 'bank.reconciliation.exception.raise', objectType: 'bank_reconciliation_exception', objectId: exceptionId, at: raisedAt,
          origin: { tenantId: t, branchId: ctx.branchId ?? null }, before: null,
          after: { statementId, lineId, amountMinor: String(line.amountMinor), ownerUserId }, ...(note === undefined ? {} : { reason: note }), correlationId: exceptionId,
        });
        return { status: 201, body: { exception: e, alreadyRaised: false } };
      },
    },
    {
      // Resolve an exception: an outcome from the fixed list, a reason in words, what it was matched to by hand (if that).
      api: 'API-09', method: 'POST', path: '/v1/finance/bank-reconciliation/exceptions/:exceptionId/resolve',
      permission: 'settlement.investigation.manage', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const exceptionId = (ctx.params['exceptionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const e = (await deps.exceptionsRaised(t)).find((x) => x.exceptionId === exceptionId);
        if (e === undefined) throw apiError(404, { code: 'exception_unknown', whatHappened: `No bank exception ${exceptionId} is raised.`, wasItSaved: 'not_saved', nextSafeAction: 'Choose an exception from the statement. Nothing was changed.' });
        if (!isStr(b['reason'])) throw apiError(400, { code: 'resolve_needs_a_reason', whatHappened: 'Resolving a bank exception needs { outcome, reason } — why the line is settled, in words.', wasItSaved: 'not_saved', nextSafeAction: 'Say why. Nothing was changed.' });
        if (!(EXCEPTION_OUTCOMES as readonly string[]).includes(String(b['outcome']))) {
          throw apiError(400, { code: 'outcome_unknown', whatHappened: `'${String(b['outcome'])}' is not an outcome. One of: ${EXCEPTION_OUTCOMES.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Choose the outcome from the list. Nothing was changed.' });
        }
        const prior = (await deps.exceptionsResolved(t)).find((r) => r.exceptionId === exceptionId);
        if (prior !== undefined) return { status: 200, body: { resolved: prior, alreadyResolved: true } };
        const matchedTo = typeof b['matchedTo'] === 'string' && b['matchedTo'].trim() !== '' ? b['matchedTo'].trim().slice(0, 120) : undefined;
        const at = deps.now();
        const r: BankLineExceptionResolved = { exceptionId, outcome: b['outcome'] as ExceptionOutcome, reason: b['reason'].trim().slice(0, 300), ...(matchedTo === undefined ? {} : { matchedTo }), by: ctx.userId, at };
        await deps.recordResolved(t, r);
        await deps.recordAudit?.(t, {
          actorId: ctx.userId, action: 'bank.reconciliation.exception.resolve', objectType: 'bank_reconciliation_exception', objectId: exceptionId, at,
          origin: { tenantId: t, branchId: ctx.branchId ?? null }, before: { state: 'open', amountMinor: String(e.amountMinor) }, after: { state: 'resolved', outcome: r.outcome, ...(matchedTo === undefined ? {} : { matchedTo }) },
          reason: r.reason, correlationId: exceptionId,
        });
        return { status: 201, body: { resolved: r, alreadyResolved: false } };
      },
    },
  ];
}
