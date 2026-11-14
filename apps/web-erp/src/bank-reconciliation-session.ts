// Bank reconciliation (U6 · M23-FR-03 · QG-07 · P-08) — a tested, DOM-free session over head office's line-by-line routes:
//   • `GET /v1/finance/bank-reconciliation[?statementId=]` (`settlement.review.read`): the statement asked for, else the
//     newest imported, every line matched to a provider payout or a cash deposit, or carrying an exception, or unmatched
//     with its value; the totals; the statements to choose from;
//   • `POST /v1/finance/bank-reconciliation/exceptions/:id` (`settlement.investigation.manage`): raise an exception on an
//     unmatched line for a named owner; `…/:id/resolve`: resolve it with an outcome and a reason.
// Head office re-checks every permission; `may` only shapes what is offered. Statements are IMPORTED on the Card, UPI and
// bank page — this page never imports. Every word this page adds has a Tamil twin (OB-699); head office's own sentences
// (a refusal's words) stay English.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';
import type { RefusalLang } from './refusal-words';

export type Lang = 'en' | 'ta';

export const EXCEPTION_OUTCOMES = ['matched_by_hand', 'bank_error', 'not_ours', 'timing', 'other'] as const;
export type ExceptionOutcome = (typeof EXCEPTION_OUTCOMES)[number];

export const BANK_RECONCILIATION_COPY = {
  en: {
    title: 'Bank reconciliation',
    lead: 'Every line of the bank statement, matched to what the books know — a provider payout, a cash deposit or a supplier payment (by its bank reference) — or left unmatched with its value. An unmatched line is raised as an exception a named person owns and resolves with a reason. Nothing here moves money. Statements are imported on the Card, UPI and bank page.',
    statement: 'Statement', chooseStatement: 'Which statement', show: 'Show', reload: 'Read again from head office', noStatements: 'No bank statement has been imported yet.',
    noStatementsDetail: 'Import the bank\'s statement on the Card, UPI and bank page; this page then reads it line by line.', importPage: 'Open Card, UPI and bank',
    linesH: 'Statement lines', date: 'Date', amount: 'Amount', reference: 'Bank reference', narrative: 'Narrative', match: 'Matched to', owner: 'Owner', action: 'Action',
    cLines: 'Lines', cMatched: 'Matched', cUnmatched: 'Unmatched', cUnmatchedValue: 'Unmatched value', cOpen: 'Open exceptions', cOverdue: 'Overdue exceptions', cCredits: 'Credits in', cDebits: 'Debits out',
    addsUp: 'The statement adds up: opening plus every line is the closing balance.', doesNotAddUp: 'The statement does NOT add up to its own closing balance — a person must look at the import.',
    provider_payout: 'Provider payout', cash_deposit: 'Cash deposit', exception: 'Exception', unmatched: 'Unmatched',
    supplier_payment: 'Supplier payment', paymentRef: 'ref', // U7 · OB-724 — a debit line matched by its reference to a payment recorded on Supplier bills
    open: 'open', resolved: 'resolved', overdue: 'overdue — raised on an earlier shop day', raisedOn: 'raised on', slip: 'slip', batch: 'file',
    raiseH: 'Raise an exception on an unmatched line', raiseLead: 'The line keeps its value; a named person owns the exception until it is resolved with a reason — the same shop day, if it can be (§34.1).',
    line: 'Statement line', chooseLine: 'Choose an unmatched line', ownerField: 'Who owns it', note: 'Note (what is known so far)', raise: 'Raise the exception', pickLine: 'Raise',
    resolveH: 'Resolve an exception', resolveLead: 'Say how the line is settled: matched by hand to a bill or a payment, a bank error, not ours, a timing difference, or another reason in words.',
    exceptionField: 'Exception', chooseException: 'Choose an open exception', outcome: 'Outcome', reason: 'Why', matchedTo: 'Matched to (a bill, a payment, a slip)', resolve: 'Record the resolution', pickException: 'Resolve',
    matched_by_hand: 'Matched by hand', bank_error: 'Bank error', not_ours: 'Not ours', timing: 'Timing difference', other: 'Other reason',
    confirmRaiseTitle: 'Raise this exception?', confirmRaiseDetail: 'Line {line} for {amount} will be recorded as an exception owned by {owner}, in your name. It stays open until it is resolved with a reason.',
    confirmResolveTitle: 'Resolve this exception?', confirmResolveDetail: 'Exception {id} will be recorded as "{outcome}" in your name, with your reason. A resolution is kept for good; a wrong one is answered by a new exception, never by editing this one.',
    authorityRaise: 'Anyone who manages settlement cases may raise one.', authorityResolve: 'The owner or the accountant resolves it; the reason is kept with the record.',
    raised: 'Exception raised.', resolvedOk: 'Resolution recorded.', confirmUnavailable: 'The confirm step could not open, so nothing was sent.',
    needLine: 'Choose an unmatched line first.', needOwner: 'Choose who owns the exception first.', needException: 'Choose an open exception first.', needReason: 'Say why, in words.', needOutcome: 'Choose an outcome.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the bank reconciliation.', cannotManage: 'Your role can read the reconciliation but cannot raise or resolve an exception.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.', reading: 'Reading from head office…',
    notReadDetail: 'Head office has not answered, so nothing here is known.', covers: 'Statement {id} · {account} · {from} to {to} · read at {time}',
    headOfficeEnglish: 'Head office\'s own sentences are in English.', noLines: 'This statement has no lines.', noLinesDetail: 'The bank\'s file had a header and nothing under it.',
    exceptionsH: 'Exceptions on this statement', exceptionsNone: 'No exception has been raised on this statement.', exceptionsNoneDetail: 'Every line is matched, or nobody has raised one yet.',
    state: 'State', raisedBy: 'Raised by', resolvedBy: 'Resolved by', value: 'Value',
  },
  ta: {
    title: 'வங்கி சரிக்கட்டல்',
    lead: 'வங்கி அறிக்கையின் ஒவ்வொரு வரியும் கணக்குகளுக்குத் தெரிந்தவற்றுடன் — வழங்குநர் செலுத்துதல், பணம் செலுத்தல் அல்லது (வங்கிக் குறிப்பின்படி) விநியோகஸ்தருக்குச் செலுத்தியது — பொருத்தப்படுகிறது; பொருந்தாதது அதன் மதிப்புடன் தனியே காட்டப்படுகிறது. பொருந்தாத வரி, பெயரிடப்பட்ட ஒருவர் பொறுப்பேற்று காரணத்துடன் தீர்க்கும் விதிவிலக்காகப் பதிவாகும். இங்கே பணம் நகராது. அறிக்கைகள் "அட்டை, UPI மற்றும் வங்கி" பக்கத்தில் ஏற்றப்படுகின்றன.',
    statement: 'அறிக்கை', chooseStatement: 'எந்த அறிக்கை', show: 'காட்டு', reload: 'தலைமை அலுவலகத்திலிருந்து மீண்டும் படி', noStatements: 'இன்னும் வங்கி அறிக்கை எதுவும் ஏற்றப்படவில்லை.',
    noStatementsDetail: '"அட்டை, UPI மற்றும் வங்கி" பக்கத்தில் வங்கி அறிக்கையை ஏற்றுங்கள்; பிறகு இந்தப் பக்கம் அதை வரிவரியாகப் படிக்கும்.', importPage: 'அட்டை, UPI மற்றும் வங்கி பக்கத்தைத் திற',
    linesH: 'அறிக்கை வரிகள்', date: 'தேதி', amount: 'தொகை', reference: 'வங்கிக் குறிப்பு', narrative: 'விவரம்', match: 'பொருத்தம்', owner: 'பொறுப்பாளர்', action: 'செயல்',
    cLines: 'வரிகள்', cMatched: 'பொருந்தியவை', cUnmatched: 'பொருந்தாதவை', cUnmatchedValue: 'பொருந்தாத மதிப்பு', cOpen: 'திறந்த விதிவிலக்குகள்', cOverdue: 'காலம் கடந்த விதிவிலக்குகள்', cCredits: 'வரவுகள்', cDebits: 'செலவுகள்',
    addsUp: 'அறிக்கை சரியாகக் கூடுகிறது: தொடக்க இருப்பு + ஒவ்வொரு வரி = இறுதி இருப்பு.', doesNotAddUp: 'அறிக்கை அதன் இறுதி இருப்புக்குக் கூடவில்லை — ஏற்றுமதியை ஒருவர் பார்க்க வேண்டும்.',
    provider_payout: 'வழங்குநர் செலுத்துதல்', cash_deposit: 'பணம் செலுத்தல்', exception: 'விதிவிலக்கு', unmatched: 'பொருந்தவில்லை',
    supplier_payment: 'விநியோகஸ்தருக்குச் செலுத்தியது', paymentRef: 'குறிப்பு',
    open: 'திறந்தது', resolved: 'தீர்க்கப்பட்டது', overdue: 'காலம் கடந்தது — முந்தைய கடை நாளில் எழுப்பப்பட்டது', raisedOn: 'எழுப்பிய நாள்', slip: 'சீட்டு', batch: 'கோப்பு',
    raiseH: 'பொருந்தாத வரிக்கு விதிவிலக்கை எழுப்பு', raiseLead: 'வரி அதன் மதிப்பை வைத்திருக்கும்; காரணத்துடன் தீர்க்கப்படும் வரை பெயரிடப்பட்ட ஒருவர் பொறுப்பேற்பார் — முடிந்தால் அதே கடை நாளில் (§34.1).',
    line: 'அறிக்கை வரி', chooseLine: 'பொருந்தாத வரியைத் தேர்ந்தெடுங்கள்', ownerField: 'யார் பொறுப்பு', note: 'குறிப்பு (இதுவரை தெரிந்தது)', raise: 'விதிவிலக்கை எழுப்பு', pickLine: 'எழுப்பு',
    resolveH: 'விதிவிலக்கைத் தீர்', resolveLead: 'வரி எப்படித் தீர்ந்தது என்று சொல்லுங்கள்: பில்லுடனோ செலுத்தலுடனோ கையால் பொருத்தியது, வங்கிப் பிழை, நம்முடையதல்ல, கால வேறுபாடு, அல்லது வேறு காரணம்.',
    exceptionField: 'விதிவிலக்கு', chooseException: 'திறந்த விதிவிலக்கைத் தேர்ந்தெடுங்கள்', outcome: 'முடிவு', reason: 'ஏன்', matchedTo: 'பொருத்தியது (பில், செலுத்தல், சீட்டு)', resolve: 'தீர்வைப் பதிவு செய்', pickException: 'தீர்',
    matched_by_hand: 'கையால் பொருத்தியது', bank_error: 'வங்கிப் பிழை', not_ours: 'நம்முடையதல்ல', timing: 'கால வேறுபாடு', other: 'வேறு காரணம்',
    confirmRaiseTitle: 'இந்த விதிவிலக்கை எழுப்பவா?', confirmRaiseDetail: '{amount} தொகையின் வரி {line}, {owner} பொறுப்பில், உங்கள் பெயரில் விதிவிலக்காகப் பதிவாகும். காரணத்துடன் தீர்க்கப்படும் வரை திறந்திருக்கும்.',
    confirmResolveTitle: 'இந்த விதிவிலக்கைத் தீர்க்கவா?', confirmResolveDetail: 'விதிவிலக்கு {id} உங்கள் பெயரில் "{outcome}" என உங்கள் காரணத்துடன் பதிவாகும். தீர்வு நிரந்தரமாக வைக்கப்படும்; தவறானது புதிய விதிவிலக்கால் பதிலளிக்கப்படும், இதைத் திருத்துவதால் அல்ல.',
    authorityRaise: 'செட்டில்மென்ட் வழக்குகளை நிர்வகிப்பவர் யாரும் எழுப்பலாம்.', authorityResolve: 'உரிமையாளர் அல்லது கணக்காளர் தீர்ப்பார்; காரணம் பதிவுடன் வைக்கப்படும்.',
    raised: 'விதிவிலக்கு எழுப்பப்பட்டது.', resolvedOk: 'தீர்வு பதிவானது.', confirmUnavailable: 'உறுதிப்படுத்தும் படி திறக்கவில்லை, எனவே எதுவும் அனுப்பப்படவில்லை.',
    needLine: 'முதலில் பொருந்தாத வரியைத் தேர்ந்தெடுங்கள்.', needOwner: 'முதலில் பொறுப்பாளரைத் தேர்ந்தெடுங்கள்.', needException: 'முதலில் திறந்த விதிவிலக்கைத் தேர்ந்தெடுங்கள்.', needReason: 'ஏன் என்று வார்த்தைகளில் சொல்லுங்கள்.', needOutcome: 'முடிவைத் தேர்ந்தெடுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி வங்கி சரிக்கட்டலைப் படிக்க முடியாது.', cannotManage: 'உங்கள் பணி சரிக்கட்டலைப் படிக்கலாம், ஆனால் விதிவிலக்கை எழுப்பவோ தீர்க்கவோ முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    notReadDetail: 'தலைமை அலுவலகம் பதிலளிக்கவில்லை, எனவே இங்கே எதுவும் தெரியவில்லை.', covers: 'அறிக்கை {id} · {account} · {from} முதல் {to} வரை · படித்த நேரம் {time}',
    headOfficeEnglish: 'தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.', noLines: 'இந்த அறிக்கையில் வரிகள் இல்லை.', noLinesDetail: 'வங்கியின் கோப்பில் தலைப்பு மட்டும் இருந்தது, கீழே எதுவும் இல்லை.',
    exceptionsH: 'இந்த அறிக்கையின் விதிவிலக்குகள்', exceptionsNone: 'இந்த அறிக்கையில் விதிவிலக்கு எதுவும் எழுப்பப்படவில்லை.', exceptionsNoneDetail: 'ஒவ்வொரு வரியும் பொருந்தியுள்ளது, அல்லது யாரும் இன்னும் எழுப்பவில்லை.',
    state: 'நிலை', raisedBy: 'எழுப்பியவர்', resolvedBy: 'தீர்த்தவர்', value: 'மதிப்பு',
  },
} as const;

export const bankReconciliationWords = (lang: Lang, key: string): string =>
  (BANK_RECONCILIATION_COPY[lang] as Record<string, string>)[key] ?? (BANK_RECONCILIATION_COPY.en as Record<string, string>)[key] ?? key;

export type LineMatch =
  | { readonly kind: 'provider_payout'; readonly batchId: string; readonly providerId: string; readonly declaredNetMinor: number }
  | { readonly kind: 'cash_deposit'; readonly depositId: string; readonly slipRef: string }
  | { readonly kind: 'supplier_payment'; readonly paymentId: string; readonly supplierId: string; readonly reference: string; readonly paidOn: string }
  | { readonly kind: 'exception'; readonly exceptionId: string; readonly state: 'open' | 'resolved'; readonly overdue: boolean; readonly ownerUserId: string; readonly raisedOn: string; readonly outcome?: ExceptionOutcome; readonly matchedTo?: string; readonly reason?: string }
  | { readonly kind: 'unmatched' };
export interface StatementLine { readonly lineId: string; readonly date: string; readonly amountMinor: number; readonly reference: string; readonly narrative?: string; readonly match: LineMatch }
export interface StatementSummary { readonly statementId: string; readonly accountRef: string; readonly fromDate: string; readonly toDate: string; readonly openingMinor: number; readonly closingMinor: number; readonly lines: number }
export interface Totals { readonly lines: number; readonly creditsMinor: number; readonly debitsMinor: number; readonly matched: number; readonly matchedMinor: number; readonly unmatched: number; readonly unmatchedMinor: number; readonly openExceptions: number; readonly overdueExceptions: number; readonly resolvedExceptions: number }
export interface BankException { readonly exceptionId: string; readonly statementId: string; readonly lineId: string; readonly amountMinor: number; readonly ownerUserId: string; readonly raisedBy: string; readonly raisedAt: string; readonly raisedOn: string; readonly note?: string; readonly state: 'open' | 'resolved'; readonly overdue: boolean; readonly resolution?: { readonly outcome: ExceptionOutcome; readonly reason: string; readonly matchedTo?: string; readonly by: string; readonly at: string } }
export interface Reconciliation {
  readonly statements: readonly StatementSummary[];
  readonly statement: StatementSummary | null;
  readonly lines: readonly StatementLine[];
  readonly totals: Totals | null;
  readonly statementAddsUp: boolean | null;
  readonly exceptions: readonly BankException[];
  readonly asAt: string;
}

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needLine' | 'needOwner' | 'needException' | 'needReason' | 'needOutcome';
type Done<T> = Promise<Outcome<T, Why>>;

export interface BankReconciliationSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  read(statementId?: string): Done<Reconciliation>;
  raise(input: { readonly statementId: string; readonly lineId: string; readonly ownerUserId: string; readonly note?: string }): Done<{ exceptionId: string; alreadyRaised: boolean }>;
  resolve(exceptionId: string, input: { readonly outcome: string; readonly reason: string; readonly matchedTo?: string }): Done<{ exceptionId: string; alreadyResolved: boolean }>;
}

export const bankReconciliationOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => bankReconciliationWords(lang, k), out, lang as RefusalLang);

const isStr = (v: unknown): v is string => typeof v === 'string';
const readMatch = (raw: unknown): LineMatch => {
  const m = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (m['kind'] === 'provider_payout' && isStr(m['batchId'])) return { kind: 'provider_payout', batchId: m['batchId'], providerId: isStr(m['providerId']) ? m['providerId'] : '', declaredNetMinor: typeof m['declaredNetMinor'] === 'number' ? m['declaredNetMinor'] : 0 };
  if (m['kind'] === 'cash_deposit' && isStr(m['depositId'])) return { kind: 'cash_deposit', depositId: m['depositId'], slipRef: isStr(m['slipRef']) ? m['slipRef'] : '' };
  if (m['kind'] === 'supplier_payment' && isStr(m['paymentId'])) {
    return { kind: 'supplier_payment', paymentId: m['paymentId'], supplierId: isStr(m['supplierId']) ? m['supplierId'] : '', reference: isStr(m['reference']) ? m['reference'] : '', paidOn: isStr(m['paidOn']) ? m['paidOn'] : '' };
  }
  if (m['kind'] === 'exception' && isStr(m['exceptionId'])) {
    return {
      kind: 'exception', exceptionId: m['exceptionId'], state: m['state'] === 'resolved' ? 'resolved' : 'open', overdue: m['overdue'] === true,
      ownerUserId: isStr(m['ownerUserId']) ? m['ownerUserId'] : '', raisedOn: isStr(m['raisedOn']) ? m['raisedOn'] : '',
      ...(isStr(m['outcome']) ? { outcome: m['outcome'] as ExceptionOutcome } : {}), ...(isStr(m['matchedTo']) ? { matchedTo: m['matchedTo'] } : {}), ...(isStr(m['reason']) ? { reason: m['reason'] } : {}),
    };
  }
  return { kind: 'unmatched' };
};

export function createBankReconciliationSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly newId?: (prefix: string) => string;
}): BankReconciliationSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('settlement.review.read'), manage: named && held.has('settlement.investigation.manage') };
  const call = makeCaller({ keyPrefix: 'bank-rec', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const mint = input.newId ?? newId;
  const gate = (need: 'read' | 'manage'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : need === 'manage' && !may.manage ? { result: 'invalid', why: 'cannotManage' } : undefined;
  return {
    may,
    read: async (statementId) => {
      const no = gate('read'); if (no !== undefined) return no;
      const q = statementId === undefined || statementId.trim() === '' ? '' : `?statementId=${encodeURIComponent(statementId.trim())}`;
      const out = await call<Record<string, unknown>>('GET', `/v1/finance/bank-reconciliation${q}`);
      if (out.result !== 'ok') return out;
      const v = out.value;
      const statements = (Array.isArray(v['statements']) ? v['statements'] : []) as StatementSummary[];
      const lines = (Array.isArray(v['lines']) ? v['lines'] : []).map((raw) => {
        const l = raw as Record<string, unknown>;
        return { lineId: String(l['lineId'] ?? ''), date: String(l['date'] ?? ''), amountMinor: typeof l['amountMinor'] === 'number' ? l['amountMinor'] : 0, reference: String(l['reference'] ?? ''), ...(isStr(l['narrative']) ? { narrative: l['narrative'] } : {}), match: readMatch(l['match']) };
      });
      return {
        result: 'ok',
        value: {
          statements, statement: (v['statement'] ?? null) as StatementSummary | null, lines, totals: (v['totals'] ?? null) as Totals | null,
          statementAddsUp: typeof v['statementAddsUp'] === 'boolean' ? v['statementAddsUp'] : null,
          exceptions: (Array.isArray(v['exceptions']) ? v['exceptions'] : []) as BankException[], asAt: String(v['asAt'] ?? ''),
        },
      };
    },
    raise: async (r) => {
      const no = gate('manage'); if (no !== undefined) return no;
      if (r.statementId.trim() === '' || r.lineId.trim() === '') return { result: 'invalid', why: 'needLine' };
      if (r.ownerUserId.trim() === '') return { result: 'invalid', why: 'needOwner' };
      const exceptionId = mint('bx');
      const note = r.note?.trim() ?? '';
      const out = await call<{ exception?: { exceptionId?: string }; alreadyRaised?: boolean }>('POST', `/v1/finance/bank-reconciliation/exceptions/${encodeURIComponent(exceptionId)}`, {
        statementId: r.statementId.trim(), lineId: r.lineId.trim(), ownerUserId: r.ownerUserId.trim(), ...(note === '' ? {} : { note }),
      });
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { exceptionId, alreadyRaised: out.value.alreadyRaised === true } };
    },
    resolve: async (exceptionId, r) => {
      const no = gate('manage'); if (no !== undefined) return no;
      if (exceptionId.trim() === '') return { result: 'invalid', why: 'needException' };
      if (!(EXCEPTION_OUTCOMES as readonly string[]).includes(r.outcome)) return { result: 'invalid', why: 'needOutcome' };
      if (r.reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      const matchedTo = r.matchedTo?.trim() ?? '';
      const out = await call<{ alreadyResolved?: boolean }>('POST', `/v1/finance/bank-reconciliation/exceptions/${encodeURIComponent(exceptionId.trim())}/resolve`, {
        outcome: r.outcome, reason: r.reason.trim(), ...(matchedTo === '' ? {} : { matchedTo }),
      });
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { exceptionId: exceptionId.trim(), alreadyResolved: out.value.alreadyResolved === true } };
    },
  };
}
