// API-09 Cash deposited to the bank (W3 · M23-FR-03 "reconcile cash, bank … against POS and finance records" · QG-07 · P-08
// · hard rules #2, #3, #6, #10).
//
// The month close compared card and UPI takings with the provider's files, and the provider's payouts with the bank
// statement — but cash taken to the bank had no record at all, so the close said "Cash banked: not checked" for ever.
// This is that record, and the check it makes possible:
//
//   • RECORD a deposit (`POST /v1/finance/cash-deposits/:depositId`): the day it was paid in, the amount, the bank's
//     deposit-slip reference and the shop's own name for the account (never the account number). Once per id: the same
//     deposit again is "already recorded"; a different deposit under a used id is refused by name (hard rule #10).
//   • CANCEL a wrong one (`…/cancel`): with a reason. The record stays as evidence (hard rules #2 and #6) — the cancel is a
//     second fact, never an edit or a delete.
//   • READ (`GET /v1/finance/cash-deposits?period=`): every deposit with the bank-statement credit that names its slip for
//     the same amount, or "not in the bank yet" — a deposit is matched to one bank line at most, and a bank line to one
//     deposit at most, so a single credit can never answer two deposits.
//   • The CLOSE (`monthEvidence`) then has a third check, "Cash banked": the deposits recorded for the month against the
//     bank credits that name them. A month with no deposit recorded says so ("not checked"), never a zero.
//
// Who records: the people who already bring the bank's own evidence in (`settlement.batch.import` — the accountant and the
// owner). Nothing here posts to the books: the posting map has no kind for a deposit, and which accounts a deposit moves is
// the accountant's decision (P-05).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { BankStatement } from '../../../packages/finance/src/bank-statement';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { containsCardNumber } from '../../../packages/tender/src/card-token';

export interface CashDeposit {
  readonly depositId: string;
  /** YYYY-MM-DD — the shop's day the cash was paid in at the bank (as the slip is stamped). */
  readonly depositedOn: string;
  readonly amountMinor: number;
  /** The bank's deposit-slip number (what the statement line names). */
  readonly slipRef: string;
  /** The shop's own name for the account (e.g. "HDFC-current-1") — never the account number. */
  readonly accountRef: string;
  readonly note?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}
export interface CashDepositCancelled { readonly depositId: string; readonly reason: string; readonly by: string; readonly at: string }

export interface CashDepositView extends CashDeposit {
  readonly state: 'in_bank' | 'not_in_bank' | 'cancelled';
  /** The bank line that names the slip for the same amount (statement id and line id), when one does. */
  readonly bankLine: { readonly statementId: string; readonly lineId: string; readonly date: string } | null;
  readonly cancelled?: CashDepositCancelled;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`))
  && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const looksLikeAnAccountNumber = (s: string): boolean => /^\d{9,18}$/.test(s.replace(/[\s-]/g, ''));
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Every deposit with its state: cancelled; in the bank (a statement CREDIT naming the slip — in its reference or narrative —
 * for exactly the amount, on or after the day it was paid in); or not in the bank yet. Each bank line answers one deposit.
 * Pure.
 */
export function cashDepositViews(input: {
  readonly deposits: readonly CashDeposit[];
  readonly cancelled: readonly CashDepositCancelled[];
  readonly statements: readonly BankStatement[];
}): readonly CashDepositView[] {
  const used = new Set<string>();
  const credits = input.statements.flatMap((s) => s.lines.filter((l) => l.amountMinor > 0).map((l) => ({ statementId: s.statementId, line: l })));
  const ordered = [...input.deposits].sort((a, b) => (a.depositedOn === b.depositedOn ? a.recordedAt.localeCompare(b.recordedAt) : a.depositedOn.localeCompare(b.depositedOn)));
  const views = new Map<string, CashDepositView>();
  for (const d of ordered) {
    const cancelled = input.cancelled.find((c) => c.depositId === d.depositId);
    if (cancelled !== undefined) { views.set(d.depositId, { ...d, state: 'cancelled', bankLine: null, cancelled }); continue; }
    const hit = credits.find((c) => !used.has(`${c.statementId}:${c.line.lineId}`) && c.line.amountMinor === d.amountMinor && c.line.date >= d.depositedOn
      && (c.line.reference.includes(d.slipRef) || (c.line.narrative ?? '').includes(d.slipRef)));
    if (hit !== undefined) used.add(`${hit.statementId}:${hit.line.lineId}`);
    views.set(d.depositId, { ...d, state: hit === undefined ? 'not_in_bank' : 'in_bank', bankLine: hit === undefined ? null : { statementId: hit.statementId, lineId: hit.line.lineId, date: hit.line.date } });
  }
  return input.deposits.map((d) => views.get(d.depositId)!);
}

/** The deposits of one month (by the day paid in), not cancelled — what the close compares with the bank. Pure. */
export function depositsOfPeriod(views: readonly CashDepositView[], period: string): readonly CashDepositView[] {
  return views.filter((v) => v.state !== 'cancelled' && v.depositedOn.slice(0, 7) === period);
}

export interface CashDepositDeps {
  readonly deposits: (tenantId: string) => Promise<readonly CashDeposit[]>;
  readonly cancellations: (tenantId: string) => Promise<readonly CashDepositCancelled[]>;
  readonly statements: (tenantId: string) => Promise<readonly BankStatement[]>;
  readonly recordDeposit: (tenantId: string, d: CashDeposit) => Promise<void>;
  readonly recordCancel: (tenantId: string, c: CashDepositCancelled) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const sameDeposit = (a: CashDeposit, b: Omit<CashDeposit, 'recordedBy' | 'recordedAt'>): boolean =>
  a.depositedOn === b.depositedOn && a.amountMinor === b.amountMinor && a.slipRef === b.slipRef && a.accountRef === b.accountRef;

export function cashDepositRoutes(deps: CashDepositDeps): readonly Route[] {
  const views = async (t: string) => {
    const [deposits, cancelled, statements] = await Promise.all([deps.deposits(t), deps.cancellations(t), deps.statements(t)]);
    return cashDepositViews({ deposits, cancelled, statements });
  };
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/cash-deposits/:depositId',
      permission: 'settlement.batch.import', idempotent: true,
      handler: async (ctx) => {
        const depositId = (ctx.params['depositId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (depositId === '' || !isDate(b['depositedOn']) || !Number.isSafeInteger(b['amountMinor']) || (b['amountMinor'] as number) <= 0
          || !isStr(b['slipRef']) || !isStr(b['accountRef']) || (b['note'] !== undefined && typeof b['note'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_cash_deposit',
            whatHappened: 'A cash deposit is { depositedOn (YYYY-MM-DD), amountMinor (whole paise, more than 0), slipRef (the bank\'s deposit-slip number), accountRef (the shop\'s name for the account), note? }.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the deposit as the stamped slip shows it. Nothing was recorded.',
          });
        }
        const slipRef = b['slipRef'].trim().slice(0, 80);
        const accountRef = b['accountRef'].trim().slice(0, 80);
        const note = typeof b['note'] === 'string' && b['note'].trim() !== '' ? b['note'].trim().slice(0, 300) : undefined;
        if (looksLikeAnAccountNumber(accountRef)) {
          throw apiError(422, { code: 'account_number_not_kept', whatHappened: 'The account looks like an account number. Account numbers are not kept — name the account by the shop\'s own reference (e.g. HDFC-current-1).', wasItSaved: 'not_saved', nextSafeAction: 'Use the account\'s reference. Nothing was recorded.' });
        }
        if (containsCardNumber(slipRef) || (note !== undefined && containsCardNumber(note))) {
          throw apiError(422, { code: 'looks_like_card_data', whatHappened: 'The slip number or note holds what looks like a card number. Card numbers are never kept (hard rule #3).', wasItSaved: 'not_saved', nextSafeAction: 'Send the deposit-slip number only. Nothing was recorded.' });
        }
        const asked = { depositId, depositedOn: b['depositedOn'], amountMinor: b['amountMinor'] as number, slipRef, accountRef, ...(note === undefined ? {} : { note }) };
        const prior = (await deps.deposits(ctx.tenantId)).find((d) => d.depositId === depositId);
        if (prior !== undefined) {
          if (sameDeposit(prior, asked)) return { status: 200, body: { deposit: prior, alreadyRecorded: true } };
          throw apiError(409, {
            code: 'deposit_id_used', whatHappened: `Deposit ${depositId} is already recorded as ₹${(prior.amountMinor / 100).toFixed(2)} on ${prior.depositedOn} (slip ${prior.slipRef}) by ${prior.recordedBy}. A different deposit cannot take its place.`,
            wasItSaved: 'not_saved', nextSafeAction: 'If that record is wrong, cancel it with a reason and record the deposit again. Nothing was changed.',
          });
        }
        const others = (await deps.deposits(ctx.tenantId)).filter((d) => d.slipRef === slipRef && d.accountRef === accountRef);
        const cancelled = new Set((await deps.cancellations(ctx.tenantId)).map((c) => c.depositId));
        const live = others.find((d) => !cancelled.has(d.depositId));
        if (live !== undefined) {
          throw apiError(409, {
            code: 'slip_already_recorded', whatHappened: `Slip ${slipRef} on ${accountRef} is already recorded as deposit ${live.depositId} (₹${(live.amountMinor / 100).toFixed(2)} on ${live.depositedOn}). One slip is one deposit.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Check the slip. If the first record is wrong, cancel it with a reason first. Nothing was recorded.',
          });
        }
        const deposit: CashDeposit = { ...asked, recordedBy: ctx.userId, recordedAt: deps.now() };
        await deps.recordDeposit(ctx.tenantId, deposit);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'cash.deposit.record', objectType: 'cash_deposit', objectId: depositId, at: deposit.recordedAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { depositedOn: deposit.depositedOn, amountMinor: String(deposit.amountMinor), slipRef, accountRef }, correlationId: depositId,
        });
        return { status: 201, body: { deposit, alreadyRecorded: false } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/cash-deposits/:depositId/cancel',
      permission: 'settlement.batch.import', idempotent: true,
      handler: async (ctx) => {
        const depositId = (ctx.params['depositId'] ?? '').trim();
        const reason = (ctx.body as { reason?: unknown } | null)?.reason;
        if (!isStr(reason)) {
          throw apiError(400, { code: 'cancel_needs_a_reason', whatHappened: 'Cancelling a deposit record needs { reason } — why it is wrong.', wasItSaved: 'not_saved', nextSafeAction: 'Say why. Nothing was changed.' });
        }
        const d = (await deps.deposits(ctx.tenantId)).find((x) => x.depositId === depositId);
        if (d === undefined) throw apiError(404, { code: 'cash_deposit_unknown', whatHappened: `No cash deposit ${depositId} is recorded.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the deposit. Nothing was changed.' });
        const prior = (await deps.cancellations(ctx.tenantId)).find((c) => c.depositId === depositId);
        if (prior !== undefined) return { status: 200, body: { cancelled: prior, alreadyCancelled: true } };
        const c: CashDepositCancelled = { depositId, reason: reason.trim().slice(0, 300), by: ctx.userId, at: deps.now() };
        await deps.recordCancel(ctx.tenantId, c);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'cash.deposit.cancel', objectType: 'cash_deposit', objectId: depositId, at: c.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { state: 'recorded' }, after: { state: 'cancelled' }, reason: c.reason, correlationId: depositId,
        });
        return { status: 201, body: { cancelled: c, alreadyCancelled: false } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/cash-deposits',
      permission: 'settlement.review.read',
      handler: async (ctx) => {
        const period = ctx.query['period'];
        if (period !== undefined && !PERIOD.test(period)) {
          throw apiError(400, { code: 'bad_period', whatHappened: `'${period}' is not a month (YYYY-MM).`, wasItSaved: 'not_saved', nextSafeAction: 'Send the month as YYYY-MM, or leave it out for every deposit. A read never writes.' });
        }
        const all = await views(ctx.tenantId);
        const shown = period === undefined ? all : all.filter((v) => v.depositedOn.slice(0, 7) === period);
        const live = shown.filter((v) => v.state !== 'cancelled');
        return {
          status: 200,
          body: {
            deposits: shown, ...(period === undefined ? {} : { period }),
            recordedMinor: live.reduce((n, v) => n + v.amountMinor, 0),
            inBankMinor: live.filter((v) => v.state === 'in_bank').reduce((n, v) => n + v.amountMinor, 0),
            notInBank: live.filter((v) => v.state === 'not_in_bank').length,
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
