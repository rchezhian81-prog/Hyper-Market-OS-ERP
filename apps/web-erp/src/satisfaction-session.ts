// Customer satisfaction (U6 · UI/UX gap audit §27 "CRM · feedback / satisfaction" · M21-FR-04 · crm-service.md "Satisfaction")
// — the page over head office's CSAT routes: a customer's rating of a case that has been dealt with
// (`POST /v1/service/cases/:caseId/satisfaction`, append-only, in the case's OWN customer's name — never typed), and the
// service report's CSAT with its response rate beside it (`GET /v1/service/report`: six replies out of four hundred cases is
// six people, not a score). A rating on an open case is head office's refusal, said in its words. Every word this page adds
// has a Tamil twin; head office's own sentences stay in English (OB-553, OB-699).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const SATISFACTION_COPY = {
  en: {
    title: 'Customer satisfaction',
    lead: 'How customers rated the cases the desk dealt with, and where to record a rating. A rating is for a case that has been resolved or closed, in that customer\'s own name.',
    reportH: 'How the service is doing', csat: 'Satisfaction (1–5)', responses: 'Ratings received', responseRate: 'Of resolved cases rated', casesCount: 'Cases', resolved: 'Resolved',
    noResponses: 'No customer has rated a case yet.', notMeaningful: 'too few to mean anything',
    casesH: 'Choose the case to rate', casesLead: 'Resolved and closed cases first — those a customer can rate. An open case cannot be rated until it is dealt with.',
    caseCol: 'Case', customer: 'Customer', kindCol: 'Kind', state: 'State', summary: 'What it was about', resolvedCol: 'Resolved', ratable: 'Can be rated', notRatable: 'not yet — still open', yes: 'yes', choose: 'Choose',
    noCases: 'The desk holds no case.', noCasesDetail: 'A rating is recorded on a case; open one on the Customer cases page first.',
    rateH: 'Record the rating', forCase: 'Case', forCustomer: 'In the name of', score: 'Score', scoreHint: '1 = poor, 5 = very good', comment: 'What they said (optional)', record: 'Record the rating',
    s1: 'Poor', s2: 'Not good', s3: 'Fair', s4: 'Good', s5: 'Very good',
    recorded: 'Recorded. Thank the customer; the report counts it from now.', needScore: 'Choose a score from 1 to 5.', needCustomer: 'This case names no customer, so no rating can be recorded in their name.', needCase: 'Choose a case first.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the service desk.', cannotManage: 'Your role can read the desk but may not record a rating.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
    headOfficeEnglish: 'Head office\'s own sentences are in English.', reload: 'Read again', back: 'Choose another case',
    kind_complaint: 'Complaint', kind_enquiry: 'Enquiry', kind_warranty: 'Warranty', kind_lost_and_found: 'Lost and found',
  },
  ta: {
    title: 'வாடிக்கையாளர் திருப்தி',
    lead: 'மேசை கையாண்ட வழக்குகளை வாடிக்கையாளர்கள் எப்படி மதிப்பிட்டார்கள், மதிப்பீட்டை எங்கே பதிவு செய்வது. மதிப்பீடு தீர்க்கப்பட்ட அல்லது மூடப்பட்ட வழக்குக்கு, அந்த வாடிக்கையாளரின் சொந்தப் பெயரில்.',
    reportH: 'சேவை எப்படி உள்ளது', csat: 'திருப்தி (1–5)', responses: 'பெற்ற மதிப்பீடுகள்', responseRate: 'தீர்க்கப்பட்டவற்றில் மதிப்பிடப்பட்டவை', casesCount: 'வழக்குகள்', resolved: 'தீர்க்கப்பட்டவை',
    noResponses: 'இன்னும் எந்த வாடிக்கையாளரும் வழக்கை மதிப்பிடவில்லை.', notMeaningful: 'பொருள் கொள்ள மிகக் குறைவு',
    casesH: 'மதிப்பிட வழக்கைத் தேர்ந்தெடுங்கள்', casesLead: 'தீர்க்கப்பட்ட, மூடப்பட்ட வழக்குகள் முதலில் — வாடிக்கையாளர் மதிப்பிடக்கூடியவை. திறந்த வழக்கு கையாளப்படும் வரை மதிப்பிட முடியாது.',
    caseCol: 'வழக்கு', customer: 'வாடிக்கையாளர்', kindCol: 'வகை', state: 'நிலை', summary: 'எதைப் பற்றியது', resolvedCol: 'தீர்க்கப்பட்டது', ratable: 'மதிப்பிடலாம்', notRatable: 'இன்னும் இல்லை — திறந்தே உள்ளது', yes: 'ஆம்', choose: 'தேர்ந்தெடு',
    noCases: 'மேசையில் வழக்கு எதுவும் இல்லை.', noCasesDetail: 'மதிப்பீடு வழக்கின் மீது பதிவாகிறது; முதலில் வாடிக்கையாளர் வழக்குகள் பக்கத்தில் ஒன்றைத் திறங்கள்.',
    rateH: 'மதிப்பீட்டைப் பதிவு செய்', forCase: 'வழக்கு', forCustomer: 'யார் பெயரில்', score: 'மதிப்பெண்', scoreHint: '1 = மோசம், 5 = மிக நன்று', comment: 'அவர்கள் சொன்னது (விருப்பம்)', record: 'மதிப்பீட்டைப் பதிவு செய்',
    s1: 'மோசம்', s2: 'நன்றாக இல்லை', s3: 'பரவாயில்லை', s4: 'நன்று', s5: 'மிக நன்று',
    recorded: 'பதிவானது. வாடிக்கையாளருக்கு நன்றி சொல்லுங்கள்; அறிக்கை இனி இதைக் கணக்கிடும்.', needScore: '1 முதல் 5 வரை மதிப்பெண்ணைத் தேர்ந்தெடுங்கள்.', needCustomer: 'இந்த வழக்கில் வாடிக்கையாளர் பெயர் இல்லை, எனவே அவர் பெயரில் மதிப்பீடு பதிவு செய்ய முடியாது.', needCase: 'முதலில் ஒரு வழக்கைத் தேர்ந்தெடுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு சேவை மேசையைப் பார்க்க முடியாது.', cannotManage: 'உங்கள் பங்கு மேசையைப் படிக்கலாம், ஆனால் மதிப்பீட்டைப் பதிவு செய்ய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    headOfficeEnglish: 'தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.', reload: 'மீண்டும் படி', back: 'வேறு வழக்கைத் தேர்ந்தெடு',
    kind_complaint: 'புகார்', kind_enquiry: 'விசாரணை', kind_warranty: 'உத்தரவாதம்', kind_lost_and_found: 'தொலைந்தது கிடைத்தது',
  },
} as const;

export const satisfactionWords = (lang: Lang, key: string): string =>
  (SATISFACTION_COPY[lang] as Record<string, string>)[key] ?? (SATISFACTION_COPY.en as Record<string, string>)[key] ?? key;
export const satisfactionOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => satisfactionWords(lang, k), out, lang);

export interface ReportView {
  readonly cases: number; readonly resolved: number;
  /** Average CSAT in hundredths, or no responses yet. */
  readonly csat: number | 'no_responses';
  /** Ratings received out of resolved cases, in basis points, or not meaningful. */
  readonly responseRateBps: number | 'not_meaningful';
  readonly detail: string;
}
export interface CaseRow {
  readonly caseId: string; readonly customerRef: string; readonly kind: string; readonly state: string; readonly summary: string;
  readonly openedAt: string; readonly resolvedAt?: string;
}
export interface RatableRow extends CaseRow { readonly ratable: boolean }

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needScore' | 'needCustomer' | 'needCase';
type Done<T> = Promise<Outcome<T, Why>>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The cases a customer can rate first (resolved or closed, the newest resolved first), then the rest, newest opened first. */
export function ratableFirst(cases: readonly CaseRow[]): readonly RatableRow[] {
  const ratable = (c: CaseRow): boolean => c.state === 'resolved' || c.state === 'closed';
  const by = (a: string | undefined, b: string | undefined): number => (b ?? '').localeCompare(a ?? '');
  return [...cases].map((c) => ({ ...c, ratable: ratable(c) })).sort((a, b) => {
    if (a.ratable !== b.ratable) return a.ratable ? -1 : 1;
    return a.ratable ? by(a.resolvedAt, b.resolvedAt) : by(a.openedAt, b.openedAt);
  });
}

export interface SatisfactionSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  report(): Done<ReportView>;
  cases(): Done<readonly RatableRow[]>;
  record(i: { readonly caseId: string; readonly customerRef: string; readonly score: string; readonly comment: string }): Done<{ readonly caseId: string; readonly score: number; readonly at: string }>;
}

export function createSatisfactionSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): SatisfactionSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('service.case.read'), manage: named && held.has('service.case.manage') };
  const call = makeCaller({ keyPrefix: 'csat', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (): { result: 'invalid'; why: Why } | undefined => (!named ? no('nobody') : !may.read ? no('cannotRead') : undefined);
  return {
    may,
    report: async () => {
      const g = gate(); if (g !== undefined) return g;
      const out = await call<Record<string, unknown>>('GET', '/v1/service/report');
      if (out.result !== 'ok') return out;
      const v = out.value;
      return { result: 'ok', value: {
        cases: typeof v['cases'] === 'number' ? v['cases'] : 0, resolved: typeof v['resolved'] === 'number' ? v['resolved'] : 0,
        csat: typeof v['csatHundredths'] === 'number' ? v['csatHundredths'] : 'no_responses',
        responseRateBps: typeof v['responseRateBps'] === 'number' ? v['responseRateBps'] : 'not_meaningful', detail: str(v['detail']),
      } };
    },
    cases: async () => {
      const g = gate(); if (g !== undefined) return g;
      const out = await call<{ cases?: unknown }>('GET', '/v1/service/cases');
      if (out.result !== 'ok') return out;
      const rows = Array.isArray(out.value.cases) ? out.value.cases as Record<string, unknown>[] : [];
      return { result: 'ok', value: ratableFirst(rows.map((c) => ({
        caseId: str(c['caseId']), customerRef: str(c['customerRef']), kind: str(c['kind']), state: str(c['state']), summary: str(c['summary']),
        openedAt: str(c['openedAt']), ...(typeof c['resolvedAt'] === 'string' ? { resolvedAt: c['resolvedAt'] } : {}),
      }))) };
    },
    record: async (i) => {
      const g = gate(); if (g !== undefined) return g;
      if (!may.manage) return no('cannotManage');
      if (i.caseId.trim() === '') return no('needCase');
      if (i.customerRef.trim() === '') return no('needCustomer');
      const score = Number(i.score);
      if (!/^[1-5]$/.test(i.score.trim()) || !Number.isInteger(score)) return no('needScore');
      const comment = i.comment.trim();
      return call('POST', `/v1/service/cases/${encodeURIComponent(i.caseId.trim())}/satisfaction`, { customerRef: i.customerRef.trim(), score, ...(comment === '' ? {} : { comment }) });
    },
  };
}
