// API-09 General-ledger ACCOUNT OPENINGS (GT-05 · MG-08 "load and sign off … accounting openings" · MG-06 · §17.1 "trial
// balance / control accounts" · §17.2 "zero unexplained difference in mandatory financial control totals" · M23-FR-01 · §28 ·
// QG-07 · hard rules #2 #10 · P-08).
//
// On cutover day the books do not start at zero: every ledger account carries the balance the old system's trial balance
// says it holds. Those balances are the shop's opening position, and they go in through the SAME finance posting path every
// other journal takes (`postJournal`: balanced, narrated, never into a closed month) — never as a figure typed into a table.
//
//   • RECORD (`POST /v1/finance/account-openings/:loadId`) — the old trial balance as mapped to this system's accounts
//     (MG-03): one line per account, debit OR credit, whole paise. It must balance (debits = credits) or it is refused by name.
//     Recording does NOT post: an unsigned trial balance is not the books. Append-only: the same load sent again is the same
//     record (a re-run doubles nothing); the same load with DIFFERENT figures is a visible conflict, never an overwrite (#10).
//   • SIGN OFF (`POST /v1/finance/account-openings/:loadId/sign-off`) — a SECOND finance person, holding the authority to sign a
//     period (`finance.period.sign`: the accountant, the CA, the owner) and NOT the one who recorded it, states the old system's
//     own trial-balance totals (debit, credit, number of accounts). Refused unless the recorded lines agree to the paisa
//     (MG-06). Only then is ONE opening journal posted (entry `opening-<loadId>`), dated the opening date. A sign-off that was
//     interrupted after it was kept is completed by sending it again — the journal is keyed on the load, so it posts once.
//   • READ BACK (`GET /v1/finance/account-openings/:loadId`) — the recorded trial balance beside what the LEDGER now holds for
//     each account from the posted opening journal, account by account, with every difference named; and the
//     `opening_balances` clearing account across every journal (the account the supplier-opening sub-ledger posts against,
//     packages/finance/src/payables.ts), which must come to nothing once every sub-ledger opening is in.
//
// A wrong opening is never edited: it is corrected by the accountant's journal in the open period (hard rule #2).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { postJournal, type JournalEntry, type PeriodState } from './index';

/** One ledger account's balance on the old system's trial balance, mapped to this system's account code. */
export interface AccountOpeningLine {
  readonly accountCode: string;
  readonly accountName: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

/** The trial balance a load carries in. Never edited. */
export interface AccountOpeningsRecord {
  readonly loadId: string;
  /** YYYY-MM-DD — the date the opening books are true at (the cutover date). */
  readonly openingDate: string;
  readonly lines: readonly AccountOpeningLine[];
  readonly debitTotalMinor: number;
  readonly creditTotalMinor: number;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** A second finance person's sign-off of a load's trial balance against the old system's own totals. */
export interface AccountOpeningsSignOff {
  readonly loadId: string;
  readonly entryId: string;
  readonly oldSystemDebitMinor: number;
  readonly oldSystemCreditMinor: number;
  readonly accountCount: number;
  readonly signedBy: string;
  readonly signedAt: string;
  readonly note: string | null;
}

export interface AccountOpeningsDeps {
  readonly records: (tenantId: string) => Promise<readonly AccountOpeningsRecord[]> | readonly AccountOpeningsRecord[];
  /** Append the record; resolve the record that STANDS for the load (another writer's, when theirs landed first). */
  readonly recordOpenings: (tenantId: string, record: AccountOpeningsRecord) => Promise<AccountOpeningsRecord | void> | AccountOpeningsRecord | void;
  readonly signOffs: (tenantId: string) => Promise<readonly AccountOpeningsSignOff[]> | readonly AccountOpeningsSignOff[];
  /** Append the sign-off; resolve the sign-off that STANDS for the load. */
  readonly recordSignOff: (tenantId: string, signOff: AccountOpeningsSignOff) => Promise<AccountOpeningsSignOff | void> | AccountOpeningsSignOff | void;
  /** Every journal the ledger holds — the finance posting path's own record. */
  readonly journals: (tenantId: string) => Promise<readonly JournalEntry[]> | readonly JournalEntry[];
  readonly periodStates: (tenantId: string) => Promise<ReadonlyMap<string, PeriodState>> | ReadonlyMap<string, PeriodState>;
  readonly nextOpenPeriod: (tenantId: string) => Promise<string> | string;
  /** The finance posting path's append (idempotent on the entry id). */
  readonly appendJournal: (tenantId: string, e: JournalEntry) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

/** The clearing account sub-ledger openings post against (payables.ts) — it nets to nothing once every opening is in. */
export const OPENING_CLEARING_ACCOUNT = 'opening_balances';
export const openingEntryId = (loadId: string): string => `opening-${loadId}`;
/** OB-44: the compensating journal that undoes a load's opening inside the cutover window — its own entry, never an edit. */
export const openingReversalEntryId = (loadId: string): string => `opening-${loadId}-reversal`;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Every reason these lines are not a usable trial balance, in words the accountant can check. Empty = usable. */
export function trialBalanceProblems(lines: unknown): readonly string[] {
  if (!Array.isArray(lines) || lines.length === 0) return ['the trial balance needs at least one account line'];
  const p: string[] = [];
  const seen = new Set<string>();
  lines.forEach((raw, i) => {
    const l = (raw ?? {}) as Partial<AccountOpeningLine>;
    const at = `line ${i + 1}${isStr(l.accountCode) ? ` (${l.accountCode})` : ''}`;
    if (!isStr(l.accountCode)) p.push(`${at}: the account code is required`);
    else if (seen.has(l.accountCode.trim())) p.push(`${at}: the account appears twice — one balance per account`);
    else seen.add(l.accountCode.trim());
    if (!isStr(l.accountName)) p.push(`${at}: the account name is required`);
    if (!isNonNegInt(l.debitMinor) || !isNonNegInt(l.creditMinor)) p.push(`${at}: debit and credit must be whole non-negative paise`);
    else if (l.debitMinor > 0 && l.creditMinor > 0) p.push(`${at}: a balance is a debit OR a credit, not both`);
  });
  if (p.length === 0) {
    const ls = lines as AccountOpeningLine[];
    const dr = ls.reduce((s, l) => s + l.debitMinor, 0);
    const cr = ls.reduce((s, l) => s + l.creditMinor, 0);
    if (dr !== cr) p.push(`debits ${dr} and credits ${cr} differ by ${dr - cr} paise — a trial balance that does not balance cannot open the books`);
  }
  return p;
}

// Field by field, never by serialised text: a stored record comes back from PostgreSQL's JSONB with its keys reordered.
const sameFigures = (a: AccountOpeningsRecord, b: Pick<AccountOpeningsRecord, 'openingDate' | 'lines'>): boolean =>
  a.openingDate === b.openingDate && a.lines.length === b.lines.length
  && a.lines.every((l, i) => {
    const o = b.lines[i]!;
    return l.accountCode === o.accountCode && l.accountName === o.accountName && l.debitMinor === o.debitMinor && l.creditMinor === o.creditMinor;
  });

/** Net balance per account (debit positive) over a set of journals. */
function balances(journals: readonly JournalEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const j of journals) for (const l of j.lines) m.set(l.accountCode, (m.get(l.accountCode) ?? 0) + l.debitMinor - l.creditMinor);
  return m;
}

export interface AccountOpeningCheck {
  readonly check: 'account' | 'total_debit' | 'total_credit' | 'old_system_totals' | 'opening_clearing';
  readonly key: string;
  readonly expected: number;
  readonly actual: number | null;
  readonly agrees: boolean;
  readonly note?: string;
}

export function accountOpeningsRoutes(deps: AccountOpeningsDeps): readonly Route[] {
  const audit = async (tenantId: string, entry: AuditEntry): Promise<void> => { await deps.recordAudit?.(tenantId, entry); };
  const journalOf = (rec: AccountOpeningsRecord, signer: string): JournalEntry => ({
    entryId: openingEntryId(rec.loadId), period: rec.openingDate.slice(0, 7), documentDate: rec.openingDate,
    narrative: `Opening balances at ${rec.openingDate} from the old system's trial balance (load ${rec.loadId}), recorded by ${rec.recordedBy}, signed off by ${signer}`,
    lines: rec.lines.map((l) => ({ accountCode: l.accountCode, debitMinor: l.debitMinor, creditMinor: l.creditMinor })),
    postedBy: rec.recordedBy,
  });
  /** Post through the finance posting path's own rules, refused by name when they refuse. */
  const post = async (tenantId: string, entry: JournalEntry): Promise<void> => {
    const result = postJournal({ entry, periodStates: await deps.periodStates(tenantId), nextOpenPeriod: await deps.nextOpenPeriod(tenantId) });
    if (!result.ok) {
      throw apiError(422, { code: result.refusedBecause!, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: result.ownerAction ?? 'Nothing was posted. Correct the opening and sign again.' });
    }
    await deps.appendJournal(tenantId, entry);
  };
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/account-openings/:loadId',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (loadId === '' || !isDate(b['openingDate']) || !Array.isArray(b['lines'])) {
          throw apiError(400, {
            code: 'not_readable_as_account_openings',
            whatHappened: 'Opening the books needs the loadId in the path and { openingDate (YYYY-MM-DD), lines: [{ accountCode, accountName, debitMinor, creditMinor }] } — the old system\'s trial balance, mapped to this system\'s accounts.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the trial balance as the old system states it at the opening date. Nothing was recorded.',
          });
        }
        const problems = trialBalanceProblems(b['lines']);
        if (problems.length > 0) {
          throw apiError(422, {
            code: 'trial_balance_not_usable',
            whatHappened: `The trial balance cannot open the books: ${problems.join('; ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the trial balance against the old system and send it again. Nothing was recorded.',
          });
        }
        const t = ctx.tenantId;
        const lines = (b['lines'] as AccountOpeningLine[]).map((l) => ({ accountCode: l.accountCode.trim(), accountName: l.accountName.trim(), debitMinor: l.debitMinor, creditMinor: l.creditMinor }));
        const candidate = { loadId, openingDate: b['openingDate'] as string, lines };
        const prior = (await deps.records(t)).find((r) => r.loadId === loadId);
        if (prior !== undefined) {
          if (sameFigures(prior, candidate)) return { status: 200, body: { openings: prior, alreadyRecorded: true, signed: (await deps.signOffs(t)).some((s) => s.loadId === loadId) } };
          throw apiError(409, {
            code: 'account_openings_conflict',
            whatHappened: `Load ${loadId}'s trial balance is already recorded (${prior.lines.length} account(s), ${prior.debitTotalMinor} paise each side, at ${prior.openingDate}). These figures differ, and an opening is never overwritten.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Find out which trial balance is right in the old system. A wrong opening is corrected by the accountant\'s journal in the open period — never by sending it again with new numbers.',
          });
        }
        if ((await deps.periodStates(t)).get(candidate.openingDate.slice(0, 7)) === 'closed') {
          throw apiError(422, { code: 'period_is_closed', whatHappened: `${candidate.openingDate.slice(0, 7)} is closed, so the books cannot open in it.`, wasItSaved: 'not_saved', nextSafeAction: 'Open the books on a date in an open month, or have the month reopened with a second person\'s approval. Nothing was recorded.' });
        }
        const total = lines.reduce((s, l) => s + l.debitMinor, 0);
        const record: AccountOpeningsRecord = { ...candidate, debitTotalMinor: total, creditTotalMinor: total, recordedBy: ctx.userId, recordedAt: deps.now() };
        const standing = (await deps.recordOpenings(t, record)) ?? record;
        if (standing.recordedAt !== record.recordedAt || standing.recordedBy !== record.recordedBy) {
          if (sameFigures(standing, candidate)) return { status: 200, body: { openings: standing, alreadyRecorded: true, signed: false } };
          throw apiError(409, { code: 'account_openings_conflict', whatHappened: `Load ${loadId}'s trial balance was recorded by ${standing.recordedBy} at the same moment with different figures. An opening is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Find out which figure is right before anything else is done with this load.' });
        }
        await audit(t, {
          actorId: ctx.userId, action: 'finance.account_openings.record', objectType: 'migration_load', objectId: loadId,
          at: record.recordedAt, origin: { tenantId: t, branchId: ctx.branchId ?? null },
          before: {}, after: { accounts: String(lines.length), debitTotalMinor: String(total), creditTotalMinor: String(total), openingDate: record.openingDate },
          correlationId: loadId,
        });
        return { status: 201, body: { openings: record, alreadyRecorded: false, signed: false } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/account-openings/:loadId/sign-off',
      permission: 'finance.period.sign', idempotent: true,
      handler: async (ctx) => {
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (loadId === '' || !isNonNegInt(b['oldSystemDebitMinor']) || !isNonNegInt(b['oldSystemCreditMinor']) || !isNonNegInt(b['accountCount'])
          || !(b['note'] === undefined || b['note'] === null || typeof b['note'] === 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_sign_off',
            whatHappened: 'Signing off the opening trial balance needs the loadId in the path and { oldSystemDebitMinor, oldSystemCreditMinor, accountCount } — the totals printed on the old system\'s own trial balance — and an optional note.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the old system\'s trial-balance totals. Nothing was signed.',
          });
        }
        const t = ctx.tenantId;
        const rec = (await deps.records(t)).find((r) => r.loadId === loadId);
        if (rec === undefined) {
          throw apiError(404, { code: 'no_account_openings_for_load', whatHappened: `No trial balance is recorded under load ${loadId}. An empty sign-off would certify nothing.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the load id, or record the trial balance first. Nothing was signed.' });
        }
        const prior = (await deps.signOffs(t)).find((s) => s.loadId === loadId);
        if (prior !== undefined) {
          // Already signed: complete a posting an interruption may have cut short — keyed on the load, so it lands once.
          if (!(await deps.journals(t)).some((j) => j.entryId === prior.entryId)) await post(t, journalOf(rec, prior.signedBy));
          return { status: 200, body: { signOff: prior, alreadySigned: true, entryId: prior.entryId } };
        }
        if (rec.recordedBy === ctx.userId) {
          throw apiError(403, {
            code: 'signer_recorded_the_openings',
            whatHappened: `You recorded load ${loadId}'s trial balance, so you cannot also sign it off (§28: the person who loads a figure never certifies it).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask another person who may sign the accounts (the accountant, the CA or the owner) to reconcile and sign it. Nothing was signed.',
          });
        }
        if (rec.debitTotalMinor !== b['oldSystemDebitMinor'] || rec.creditTotalMinor !== b['oldSystemCreditMinor'] || rec.lines.length !== b['accountCount']) {
          throw apiError(422, {
            code: 'opening_total_differs',
            whatHappened: `Load ${loadId} holds ${rec.lines.length} account(s) with debits ${rec.debitTotalMinor} and credits ${rec.creditTotalMinor} paise; the old system's trial balance you gave says ${String(b['accountCount'])} account(s), debits ${String(b['oldSystemDebitMinor'])}, credits ${String(b['oldSystemCreditMinor'])}. They must agree to the paisa before the books open (MG-06).`,
            wasItSaved: 'not_saved',
            nextSafeAction: `Find the difference account by account (GET /v1/finance/account-openings/${loadId}). Nothing was signed or posted.`,
          });
        }
        const signOff: AccountOpeningsSignOff = {
          loadId, entryId: openingEntryId(loadId), oldSystemDebitMinor: rec.debitTotalMinor, oldSystemCreditMinor: rec.creditTotalMinor, accountCount: rec.lines.length,
          signedBy: ctx.userId, signedAt: deps.now(), note: typeof b['note'] === 'string' && b['note'].trim() !== '' ? b['note'].trim() : null,
        };
        // The posting path judges the journal FIRST (a closed month refuses), then the sign-off is kept, then it posts.
        const entry = journalOf(rec, ctx.userId);
        const verdict = postJournal({ entry, periodStates: await deps.periodStates(t), nextOpenPeriod: await deps.nextOpenPeriod(t) });
        if (!verdict.ok) {
          throw apiError(422, { code: verdict.refusedBecause!, whatHappened: verdict.detail, wasItSaved: 'not_saved', nextSafeAction: verdict.ownerAction ?? 'Nothing was signed or posted.' });
        }
        const stood = (await deps.recordSignOff(t, signOff)) ?? signOff;
        await post(t, journalOf(rec, stood.signedBy));
        if (stood.signedBy !== signOff.signedBy || stood.signedAt !== signOff.signedAt) return { status: 200, body: { signOff: stood, alreadySigned: true } };
        await audit(t, {
          actorId: ctx.userId, action: 'finance.account_openings.sign_off', objectType: 'migration_load', objectId: loadId,
          at: signOff.signedAt, origin: { tenantId: t, branchId: ctx.branchId ?? null },
          before: {}, after: { accounts: String(rec.lines.length), debitTotalMinor: String(rec.debitTotalMinor), entryId: signOff.entryId, recordedBy: rec.recordedBy },
          correlationId: loadId,
        });
        return { status: 201, body: { signOff, alreadySigned: false, entryId: signOff.entryId } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/account-openings/:loadId',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const t = ctx.tenantId;
        const rec = (await deps.records(t)).find((r) => r.loadId === loadId);
        if (rec === undefined) {
          throw apiError(404, { code: 'no_account_openings_for_load', whatHappened: `No trial balance is recorded under load ${loadId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the load id.' });
        }
        const signOff = (await deps.signOffs(t)).find((s) => s.loadId === loadId) ?? null;
        const all = await deps.journals(t);
        const opening = all.filter((j) => j.entryId === openingEntryId(loadId));
        // OB-44: once the load is reversed in the cutover window, its compensating journal sits beside it and the two net out.
        const reversal = all.filter((j) => j.entryId === openingReversalEntryId(loadId));
        const reversed = reversal.length > 0;
        const ledger = balances([...opening, ...reversal]);
        // What the LEDGER holds, per account — debit and credit as the trial balance prints them.
        const ledgerLines = [...ledger].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([accountCode, net]) => ({ accountCode, debitMinor: net > 0 ? net : 0, creditMinor: net < 0 ? -net : 0 }));
        const checks: AccountOpeningCheck[] = [];
        if (signOff !== null) {
          for (const l of rec.lines) {
            const expected = reversed ? 0 : l.debitMinor - l.creditMinor;
            const actual = ledger.get(l.accountCode) ?? null;
            checks.push({ check: 'account', key: l.accountCode, expected, actual, agrees: actual === expected || (expected === 0 && actual === null) });
          }
          for (const [code, net] of ledger) {
            if (!rec.lines.some((l) => l.accountCode === code)) checks.push({ check: 'account', key: code, expected: 0, actual: net, agrees: net === 0, note: 'in the ledger, not on the trial balance' });
          }
          const dr = ledgerLines.reduce((s, l) => s + l.debitMinor, 0);
          const cr = ledgerLines.reduce((s, l) => s + l.creditMinor, 0);
          const expDr = reversed ? 0 : signOff.oldSystemDebitMinor;
          const expCr = reversed ? 0 : signOff.oldSystemCreditMinor;
          checks.push({ check: 'total_debit', key: 'debits', expected: expDr, actual: dr, agrees: dr === expDr });
          checks.push({ check: 'total_credit', key: 'credits', expected: expCr, actual: cr, agrees: cr === expCr });
          checks.push({ check: 'old_system_totals', key: 'accounts', expected: signOff.accountCount, actual: rec.lines.length, agrees: signOff.accountCount === rec.lines.length });
        }
        // The clearing account across EVERY journal: sub-ledger openings (supplier bills) post against it; the trial balance
        // carries its control figure there. Once every opening is in it comes to nothing — anything else is a difference.
        const clearing = balances(all).get(OPENING_CLEARING_ACCOUNT);
        if (clearing !== undefined) {
          checks.push({ check: 'opening_clearing', key: OPENING_CLEARING_ACCOUNT, expected: 0, actual: clearing, agrees: clearing === 0, ...(clearing === 0 ? {} : { note: 'the sub-ledger openings and the trial balance\'s control figure do not agree, or a sub-ledger opening is not posted yet' }) });
        }
        const differences = checks.filter((c) => !c.agrees);
        return {
          status: 200,
          body: {
            loadId, openings: rec, signOff, signed: signOff !== null, posted: opening.length > 0, reversed,
            ledger: ledgerLines, checks, differences, agrees: signOff !== null && opening.length > 0 && differences.length === 0, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
