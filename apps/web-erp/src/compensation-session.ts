// Compensation (U6 · UI/UX gap audit §27 "CRM · compensation" · M21-FR-03 · §28 · crm-service.md "raise a compensation for
// approval (≤3)") — the page over head office's service-desk compensation routes and the approvals engine. A compensation is
// MONEY LEAVING THE BUSINESS: within the agent's own authority one person gives it (the confirm sheet, OB-698); above it the
// page ASKS a different person through the approvals engine (kind `service_compensation`, decided on the Approvals page in
// the checker's own session) and gives it only with that approval; above the desk ceiling nothing is sent — refused here,
// in words, before a request. The details asked for are EXACTLY the details the grant route fingerprints (its body without
// the control fields, plus the case id), so the approval opens for this grant and no other. Nothing is paid from this file:
// head office's route applies the limits, the second-person rule and the ledger (`services/customer/src/service-cases.ts`).
// Every word this page adds has a Tamil twin; head office's own sentences stay in English (OB-553, OB-699).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOf } from './message-queue-session';

export type Lang = 'en' | 'ta';

export const COMPENSATION_KINDS = ['refund', 'goodwill_credit', 'loyalty_points', 'replacement'] as const;
export type CompensationKind = (typeof COMPENSATION_KINDS)[number];

export const COMPENSATION_COPY = {
  en: {
    title: 'Compensation',
    lead: 'Give a customer goodwill money, store credit, points or a replacement on their case. Up to your own limit you give it yourself; above it a second person must approve it on the Approvals page before it is given; nobody may give more than the desk ceiling.',
    limitsH: 'The desk\'s limits', agentAlone: 'One agent alone, up to', ceiling: 'Desk ceiling, whoever signs', yours: 'You may give alone, up to',
    standard: 'Head office\'s standard limits — the owner has not set the shop\'s own.', shopsOwn: 'Limits set by the owner.',
    casesH: 'Choose the case', casesLead: 'Every case the desk holds. Choose one to see what has been given and to give more.',
    caseCol: 'Case', customer: 'Customer', kindCol: 'Kind', state: 'State', summary: 'What it is about', opened: 'Opened', choose: 'Choose',
    noCases: 'The desk holds no case.', noCasesDetail: 'Open a case on the Customer cases page first; compensation is given on a case.',
    caseH: 'Case', givenH: 'Given on this case', givenNone: 'Nothing has been given on this case.', givenNoneDetail: 'What is given here will be listed with who gave it and who approved it.',
    amount: 'Amount', reason: 'Reason', by: 'Given by', approvedBy: 'Approved by', when: 'When', status: 'Carried out',
    notCarried: 'not carried out yet', f_completed: 'done', f_pending: 'pending', f_failed: 'failed',
    askedH: 'Asked for approval', askedNone: 'No request is waiting on this case.', askedNoneDetail: 'A compensation above your limit appears here while a second person decides it.',
    reqAmount: 'Amount', reqStatus: 'Status', reqDecider: 'Who decides', reqDecidedBy: 'Decided by', giveNow: 'Give it now', askedBy: 'asked by you',
    nobodyNamed: 'nobody is named to decide it yet — ask the owner', anyApprover: 'a person who may approve compensation',
    formH: 'Give compensation', kind: 'Kind', kind_refund: 'Refund', kind_goodwill_credit: 'Goodwill credit', kind_loyalty_points: 'Loyalty points', kind_replacement: 'Replacement',
    rupees: 'Amount (₹)', why: 'Why (the reason kept on the record)', give: 'Give compensation', ask: 'Ask for approval',
    routeGive: 'Within your limit: you give it yourself, after one confirm.', routeAsk: 'Above your limit: a second person must approve it on the Approvals page first.',
    routeOver: 'Above the desk ceiling: nobody at the desk may give this much.',
    confirmGive: 'Give this compensation?', confirmGiveDetail: '{amount} ({kind}) on case {case}, in your name. It leaves the business and is recorded against you.',
    confirmAsk: 'Ask for approval?', confirmAskDetail: '{amount} ({kind}) on case {case} will wait for a second person on the Approvals page. Nothing is given until they approve.',
    authorityGive: 'Within your own limit.', authorityAsk: 'Above your limit of {limit}: a person who may approve compensation decides.', authorityApproved: 'Approved by {who} on the Approvals page.',
    given: 'Given. It is recorded against you.', asked: 'Asked. It waits for {who} on the Approvals page; come back here to give it once approved.',
    needAmount: 'Type the amount in rupees.', needMoney: 'Type the amount in rupees, like 250 or 250.50.', needReason: 'Type the reason — it is kept on the record.', needKind: 'Choose what kind of compensation.',
    overCeiling: 'More than the desk ceiling. Nobody at the desk may give this much; nothing was sent.', needCase: 'Choose a case first.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the service desk.', cannotManage: 'Your role can read the desk but may not give compensation.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
    headOfficeEnglish: 'Head office\'s own sentences are in English.', reload: 'Read again', back: 'Choose another case',
    s_waiting: 'waiting', s_approved: 'approved', s_rejected: 'rejected', s_used: 'used', s_expired: 'expired', s_unknown: 'as head office says',
  },
  ta: {
    title: 'இழப்பீடு',
    lead: 'வாடிக்கையாளரின் வழக்கில் நல்லெண்ணப் பணம், கடை வரவு, புள்ளிகள் அல்லது மாற்றுப் பொருள் கொடுங்கள். உங்கள் சொந்த வரம்பு வரை நீங்களே கொடுக்கலாம்; அதற்கு மேல் கொடுக்கும் முன் இரண்டாவது நபர் அனுமதிகள் பக்கத்தில் ஒப்புதல் அளிக்க வேண்டும்; மேசை உச்ச வரம்புக்கு மேல் யாரும் கொடுக்க முடியாது.',
    limitsH: 'மேசையின் வரம்புகள்', agentAlone: 'ஒரு முகவர் தனியாக, வரை', ceiling: 'மேசை உச்ச வரம்பு, யார் கையொப்பமிட்டாலும்', yours: 'நீங்கள் தனியாகக் கொடுக்கலாம், வரை',
    standard: 'தலைமை அலுவலகத்தின் வழக்கமான வரம்புகள் — உரிமையாளர் கடையின் சொந்த வரம்பை அமைக்கவில்லை.', shopsOwn: 'உரிமையாளர் அமைத்த வரம்புகள்.',
    casesH: 'வழக்கைத் தேர்ந்தெடுங்கள்', casesLead: 'மேசையில் உள்ள ஒவ்வொரு வழக்கும். கொடுத்ததைப் பார்க்கவும் மேலும் கொடுக்கவும் ஒன்றைத் தேர்ந்தெடுங்கள்.',
    caseCol: 'வழக்கு', customer: 'வாடிக்கையாளர்', kindCol: 'வகை', state: 'நிலை', summary: 'எதைப் பற்றியது', opened: 'திறந்தது', choose: 'தேர்ந்தெடு',
    noCases: 'மேசையில் வழக்கு எதுவும் இல்லை.', noCasesDetail: 'முதலில் வாடிக்கையாளர் வழக்குகள் பக்கத்தில் வழக்கைத் திறங்கள்; இழப்பீடு வழக்கின் மீது கொடுக்கப்படுகிறது.',
    caseH: 'வழக்கு', givenH: 'இந்த வழக்கில் கொடுத்தது', givenNone: 'இந்த வழக்கில் எதுவும் கொடுக்கப்படவில்லை.', givenNoneDetail: 'இங்கே கொடுப்பது யார் கொடுத்தார், யார் ஒப்புதல் அளித்தார் என்பதுடன் பட்டியலிடப்படும்.',
    amount: 'தொகை', reason: 'காரணம்', by: 'கொடுத்தவர்', approvedBy: 'ஒப்புதல் அளித்தவர்', when: 'எப்போது', status: 'நிறைவேற்றம்',
    notCarried: 'இன்னும் நிறைவேற்றப்படவில்லை', f_completed: 'முடிந்தது', f_pending: 'நிலுவையில்', f_failed: 'தோல்வி',
    askedH: 'ஒப்புதலுக்குக் கேட்டது', askedNone: 'இந்த வழக்கில் கோரிக்கை எதுவும் காத்திருக்கவில்லை.', askedNoneDetail: 'உங்கள் வரம்புக்கு மேல் உள்ள இழப்பீடு இரண்டாவது நபர் முடிவு செய்யும் வரை இங்கே தோன்றும்.',
    reqAmount: 'தொகை', reqStatus: 'நிலை', reqDecider: 'யார் முடிவு செய்கிறார்', reqDecidedBy: 'முடிவு செய்தவர்', giveNow: 'இப்போது கொடு', askedBy: 'நீங்கள் கேட்டது',
    nobodyNamed: 'முடிவு செய்ய இன்னும் யாரும் பெயரிடப்படவில்லை — உரிமையாளரிடம் கேளுங்கள்', anyApprover: 'இழப்பீட்டுக்கு ஒப்புதல் அளிக்கக்கூடிய ஒருவர்',
    formH: 'இழப்பீடு கொடு', kind: 'வகை', kind_refund: 'பணத் திரும்பம்', kind_goodwill_credit: 'நல்லெண்ண வரவு', kind_loyalty_points: 'விசுவாசப் புள்ளிகள்', kind_replacement: 'மாற்றுப் பொருள்',
    rupees: 'தொகை (₹)', why: 'ஏன் (பதிவில் வைக்கப்படும் காரணம்)', give: 'இழப்பீடு கொடு', ask: 'ஒப்புதலுக்குக் கேள்',
    routeGive: 'உங்கள் வரம்புக்குள்: ஒரு உறுதிப்படுத்தலுக்குப் பிறகு நீங்களே கொடுக்கிறீர்கள்.', routeAsk: 'உங்கள் வரம்புக்கு மேல்: முதலில் இரண்டாவது நபர் அனுமதிகள் பக்கத்தில் ஒப்புதல் அளிக்க வேண்டும்.',
    routeOver: 'மேசை உச்ச வரம்புக்கு மேல்: மேசையில் யாரும் இவ்வளவு கொடுக்க முடியாது.',
    confirmGive: 'இந்த இழப்பீட்டைக் கொடுக்கவா?', confirmGiveDetail: 'வழக்கு {case} மீது {amount} ({kind}), உங்கள் பெயரில். இது வணிகத்திலிருந்து வெளியேறி உங்கள் பெயரில் பதிவாகும்.',
    confirmAsk: 'ஒப்புதலுக்குக் கேட்கவா?', confirmAskDetail: 'வழக்கு {case} மீது {amount} ({kind}) அனுமதிகள் பக்கத்தில் இரண்டாவது நபருக்காகக் காத்திருக்கும். அவர்கள் ஒப்புதல் அளிக்கும் வரை எதுவும் கொடுக்கப்படாது.',
    authorityGive: 'உங்கள் சொந்த வரம்புக்குள்.', authorityAsk: 'உங்கள் வரம்பு {limit}-க்கு மேல்: இழப்பீட்டுக்கு ஒப்புதல் அளிக்கக்கூடிய ஒருவர் முடிவு செய்கிறார்.', authorityApproved: 'அனுமதிகள் பக்கத்தில் {who} ஒப்புதல் அளித்தார்.',
    given: 'கொடுக்கப்பட்டது. உங்கள் பெயரில் பதிவாகியுள்ளது.', asked: 'கேட்கப்பட்டது. அனுமதிகள் பக்கத்தில் {who}-க்காகக் காத்திருக்கிறது; ஒப்புதல் கிடைத்ததும் கொடுக்க இங்கே திரும்பி வாருங்கள்.',
    needAmount: 'தொகையை ரூபாயில் தட்டச்சு செய்யுங்கள்.', needMoney: 'தொகையை ரூபாயில் தட்டச்சு செய்யுங்கள், எ.கா. 250 அல்லது 250.50.', needReason: 'காரணத்தைத் தட்டச்சு செய்யுங்கள் — அது பதிவில் வைக்கப்படும்.', needKind: 'எந்த வகை இழப்பீடு எனத் தேர்ந்தெடுங்கள்.',
    overCeiling: 'மேசை உச்ச வரம்பை விட அதிகம். மேசையில் யாரும் இவ்வளவு கொடுக்க முடியாது; எதுவும் அனுப்பப்படவில்லை.', needCase: 'முதலில் ஒரு வழக்கைத் தேர்ந்தெடுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு சேவை மேசையைப் பார்க்க முடியாது.', cannotManage: 'உங்கள் பங்கு மேசையைப் படிக்கலாம், ஆனால் இழப்பீடு கொடுக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    headOfficeEnglish: 'தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.', reload: 'மீண்டும் படி', back: 'வேறு வழக்கைத் தேர்ந்தெடு',
    s_waiting: 'காத்திருக்கிறது', s_approved: 'ஒப்புதல் அளிக்கப்பட்டது', s_rejected: 'நிராகரிக்கப்பட்டது', s_used: 'பயன்படுத்தப்பட்டது', s_expired: 'காலாவதியானது', s_unknown: 'தலைமை அலுவலகம் சொல்வதுபோல',
  },
} as const;

export const compensationWords = (lang: Lang, key: string): string =>
  (COMPENSATION_COPY[lang] as Record<string, string>)[key] ?? (COMPENSATION_COPY.en as Record<string, string>)[key] ?? key;
export const compensationOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => compensationWords(lang, k), out, lang);

export const rupees = (minor: number): string => `${minor < 0 ? '-' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface LimitsView {
  readonly agentAuthorityMinor: number;
  readonly deskCeilingMinor: number;
  /** What the signed-in person may give alone: the desk ceiling for a person who may approve, else the agent's authority. */
  readonly ownAuthorityMinor: number;
  readonly isStandard: boolean;
}
export interface CaseRow {
  readonly caseId: string; readonly customerRef: string; readonly kind: string; readonly state: string; readonly summary: string;
  readonly openedAt: string; readonly resolvedAt?: string;
}
export interface GivenRow {
  readonly compensationId?: string; readonly kind: string; readonly amountMinor: number; readonly reason: string; readonly grantedBy: string;
  readonly approvedBy?: string; readonly at: string; readonly fulfilment?: { readonly status: string; readonly detail?: string };
}
export interface Given { readonly caseId: string; readonly compensations: readonly GivenRow[]; readonly count: number; readonly totalMinor: number }
export interface RequestRow {
  readonly requestId: string; readonly kind: string; readonly subjectRef: string; readonly status: string; readonly valueMinor?: number | null;
  readonly details?: Record<string, unknown>; readonly reason?: string; readonly decidedBy?: string; readonly decisionReason?: string;
  readonly decider?: { readonly named: boolean; readonly displayName?: string; readonly whatToDo?: string };
}
export interface GrantResult { readonly compensationId: string; readonly outcome: string; readonly amountMinor: number; readonly approvedBy?: string; readonly detail: string }

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needAmount' | 'needMoney' | 'needReason' | 'needKind' | 'overCeiling' | 'needCase';
type Done<T> = Promise<Outcome<T, Why>>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The route a typed compensation takes, decided BEFORE anything is sent: give (within the person's own authority), ask (a second person), or refused (above the ceiling). */
export function planCompensation(typed: { readonly kind: string; readonly rupees: string; readonly reason: string }, limits: LimitsView):
  Outcome<{ readonly amountMinor: number; readonly route: 'give' | 'ask' }, Why> {
  if (!(COMPENSATION_KINDS as readonly string[]).includes(typed.kind)) return { result: 'invalid', why: 'needKind' };
  if (typed.rupees.trim() === '') return { result: 'invalid', why: 'needAmount' };
  const amountMinor = paiseOf(typed.rupees);
  if (amountMinor === undefined || amountMinor <= 0) return { result: 'invalid', why: 'needMoney' };
  // the money is judged before the words: a figure above the ceiling is said as soon as it is typed
  if (amountMinor > limits.deskCeilingMinor) return { result: 'invalid', why: 'overCeiling' };
  if (typed.reason.trim() === '') return { result: 'invalid', why: 'needReason' };
  return { result: 'ok', value: { amountMinor, route: amountMinor <= limits.ownAuthorityMinor ? 'give' : 'ask' } };
}

/** The approval requests that are about THIS case's compensation — the kind the grant route opens, nothing else. */
export function requestsForCase(mine: readonly RequestRow[], caseId: string): readonly RequestRow[] {
  return mine.filter((r) => r.kind === 'service_compensation' && r.subjectRef === caseId);
}

/** Plain words for a request's summary, so the Approvals page reads what is asked without opening the details. */
export const summaryOf = (kind: string, amountMinor: number, caseId: string): string =>
  `${compensationWords('en', `kind_${kind}`)} of ${rupees(amountMinor)} on case ${caseId}`;

export interface CompensationSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean; readonly approve: boolean };
  limits(): Done<LimitsView>;
  cases(): Done<readonly CaseRow[]>;
  given(caseId: string): Done<Given>;
  requests(caseId: string): Done<readonly RequestRow[]>;
  /** Give it — within the person's own authority, or with the approval a second person gave for exactly these details. */
  give(caseId: string, i: { readonly kind: string; readonly amountMinor: number; readonly reason: string; readonly approvalId?: string }): Done<GrantResult>;
  /** Ask a second person, through the approvals engine, for exactly the grant the route will fingerprint. */
  ask(caseId: string, i: { readonly kind: string; readonly amountMinor: number; readonly reason: string }): Done<RequestRow>;
}

export function createCompensationSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): CompensationSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, read: named && held.has('service.case.read'), manage: named && held.has('service.case.manage'),
    approve: named && held.has('service.compensation.approve'),
  };
  const call = makeCaller({ keyPrefix: 'comp', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (): { result: 'invalid'; why: Why } | undefined => (!named ? no('nobody') : !may.read ? no('cannotRead') : undefined);
  const enc = encodeURIComponent;
  return {
    may,
    limits: async () => {
      const g = gate(); if (g !== undefined) return g;
      const out = await call<Record<string, unknown>>('GET', '/v1/service/compensation-policy');
      if (out.result !== 'ok') return out;
      const agentAuthorityMinor = num(out.value['agentAuthorityMinor']); const deskCeilingMinor = num(out.value['deskCeilingMinor']);
      return { result: 'ok', value: { agentAuthorityMinor, deskCeilingMinor, ownAuthorityMinor: may.approve ? deskCeilingMinor : agentAuthorityMinor, isStandard: out.value['isDefault'] === true } };
    },
    cases: async () => {
      const g = gate(); if (g !== undefined) return g;
      const out = await call<{ cases?: unknown }>('GET', '/v1/service/cases');
      if (out.result !== 'ok') return out;
      const rows = Array.isArray(out.value.cases) ? out.value.cases as Record<string, unknown>[] : [];
      return { result: 'ok', value: rows.map((c) => ({
        caseId: str(c['caseId']), customerRef: str(c['customerRef']), kind: str(c['kind']), state: str(c['state']), summary: str(c['summary']),
        openedAt: str(c['openedAt']), ...(typeof c['resolvedAt'] === 'string' ? { resolvedAt: c['resolvedAt'] } : {}),
      })) };
    },
    given: async (caseId) => {
      const g = gate(); if (g !== undefined) return g;
      if (caseId.trim() === '') return no('needCase');
      return call<Given>('GET', `/v1/service/cases/${enc(caseId.trim())}/compensations`);
    },
    requests: async (caseId) => {
      const g = gate(); if (g !== undefined) return g;
      if (caseId.trim() === '') return no('needCase');
      const out = await call<{ mine?: unknown }>('GET', '/v1/approvals/requests');
      if (out.result !== 'ok') return out;
      const mine = Array.isArray(out.value.mine) ? out.value.mine as RequestRow[] : [];
      return { result: 'ok', value: requestsForCase(mine, caseId.trim()) };
    },
    give: async (caseId, i) => {
      const g = gate(); if (g !== undefined) return g;
      if (!may.manage) return no('cannotManage');
      if (caseId.trim() === '') return no('needCase');
      const body = { kind: i.kind, amountMinor: i.amountMinor, reason: i.reason.trim(), ...(i.approvalId === undefined || i.approvalId.trim() === '' ? {} : { approvalId: i.approvalId.trim() }) };
      return call<GrantResult>('POST', `/v1/service/cases/${enc(caseId.trim())}/compensation`, body);
    },
    ask: async (caseId, i) => {
      const g = gate(); if (g !== undefined) return g;
      if (!may.manage) return no('cannotManage');
      if (caseId.trim() === '') return no('needCase');
      const id = caseId.trim(); const reason = i.reason.trim();
      // EXACTLY what the grant route fingerprints: its body without the control fields, plus the path's case id.
      const details = { kind: i.kind, amountMinor: i.amountMinor, reason, caseId: id };
      return call<RequestRow>('POST', '/v1/approvals/requests', {
        kind: 'service_compensation', subjectRef: id, valueMinor: i.amountMinor, details, summary: summaryOf(i.kind, i.amountMinor, id), reason,
      });
    },
  };
}
