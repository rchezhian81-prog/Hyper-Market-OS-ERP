// The Rebates page's "earned" steps (W3 · D03-FR-03 "accrue rebate/funding claims" · D10-FR-04 "rebate liabilities" ·
// M06-FR-03 "a rebate accrues and reconciles to finance" · P-08 · hard rule #2) — a tested, DOM-free session over the two
// head-office routes no screen reached:
//   • MEASURE what a scheme earned in a period (`POST /v1/purchase/rebate-schemes/:schemeId/accruals/:accrualId`): only the
//     period is sent — head office folds the basis from the supplier's matched bills (a typed figure is refused). The
//     accrual id is the period itself, so measuring the same period again REPLACES that measurement (head office keeps
//     the history), never adds a second one;
//   • the BOOKS (`GET /v1/finance/rebate-accruals`): per scheme, earned on the register against earned in the books,
//     received, and what is still to post — and PUT IT IN THE BOOKS (`POST /v1/finance/rebate-accruals/post`) through the
//     accountant's posting rule `supplier_rebate_accrual` (a re-measure down posts the mirror entry, never an edit).
// Head office re-checks every permission; `may` only shapes what is offered.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const REBATE_ACCRUAL_COPY = {
  en: {
    measureH: 'Measure what a scheme earned', measureLead: 'Choose a scheme and the period. Head office works out what was earned from the supplier\'s matched bills — nothing is typed. Measuring the same period again replaces that measurement.',
    schemeId: 'Scheme code', from: 'From (YYYY-MM-DD)', to: 'To (YYYY-MM-DD)', baseFrom: 'Compare with, from (growth schemes only)', baseTo: 'Compare with, to (growth schemes only)', measure: 'Measure',
    measured: 'Measured: {amount} earned on {bills} matched bill(s).', notValued: '{count} bill(s) could not be valued and are left out — head office lists them.',
    booksH: 'Earned rebates in the books', booksLead: 'What each scheme earned on the register, against what the books hold for it. Only an approved scheme is put in the books. Which accounts it uses is the accountant\'s rule.',
    show: 'Show the books', post: 'Put earned rebates in the books', colScheme: 'Scheme', colRegister: 'Earned (register)', colLedger: 'Earned (books)', colReceived: 'Received', colReceivable: 'Still to come (books)', colToPost: 'To post', colAgrees: 'Agrees',
    yes: 'yes', no: 'NO', notApproved: 'not approved — not put in the books', notMapped: 'not known — the accountant has not set the rule', allAgree: 'The books agree with the register for every scheme.', someDiffer: 'The books and the register differ — post, or find out why.',
    accounts: 'Posts to: {receivable} (receivable) and {income} (income)', noRule: 'The accountant has not set the posting rule for earned rebates yet — nothing can be put in the books.',
    posted: '{count} entr(ies) put in the books.', nothingToPost: 'Nothing to post — the books already hold what the register earned.', notPostedFor: 'Not posted for {scheme}: {reason}',
    noSchemes: 'No rebate scheme is recorded yet.',
    needMeasure: 'Write the scheme code and both days (YYYY-MM-DD).', needBaseline: 'Write both comparison days (YYYY-MM-DD), or leave both empty.',
    nobody: 'Nobody is signed in on this screen.', cannotMeasure: 'Your role cannot measure rebates.', cannotRead: 'Your role cannot see the books.', cannotPost: 'Your role cannot post to the books.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    measureH: 'ஒரு திட்டம் ஈட்டியதைக் கணக்கிடு', measureLead: 'ஒரு திட்டத்தையும் காலத்தையும் தேர்ந்தெடுங்கள். விநியோகஸ்தரின் பொருந்திய பில்களிலிருந்து தலைமை அலுவலகம் ஈட்டியதைக் கணக்கிடும் — எதுவும் தட்டச்சு செய்யப்படாது. அதே காலத்தை மீண்டும் கணக்கிட்டால் அந்தக் கணக்கு மாற்றப்படும்.',
    schemeId: 'திட்டக் குறியீடு', from: 'முதல் (YYYY-MM-DD)', to: 'வரை (YYYY-MM-DD)', baseFrom: 'ஒப்பிட, முதல் (வளர்ச்சித் திட்டம் மட்டும்)', baseTo: 'ஒப்பிட, வரை (வளர்ச்சித் திட்டம் மட்டும்)', measure: 'கணக்கிடு',
    measured: 'கணக்கிடப்பட்டது: {bills} பொருந்திய பில்களில் {amount} ஈட்டியது.', notValued: '{count} பில்களை மதிப்பிட முடியவில்லை, அவை விடப்பட்டன — தலைமை அலுவலகம் பட்டியலிடுகிறது.',
    booksH: 'கணக்குப் புத்தகத்தில் ஈட்டிய தள்ளுபடிகள்', booksLead: 'ஒவ்வொரு திட்டமும் பதிவேட்டில் ஈட்டியது, புத்தகத்தில் அதற்கு உள்ளதுடன் ஒப்பிட்டு. அனுமதிக்கப்பட்ட திட்டம் மட்டுமே புத்தகத்தில் சேர்க்கப்படும். எந்தக் கணக்குகள் என்பது கணக்காளரின் விதி.',
    show: 'புத்தகத்தைக் காட்டு', post: 'ஈட்டிய தள்ளுபடிகளைப் புத்தகத்தில் சேர்', colScheme: 'திட்டம்', colRegister: 'ஈட்டியது (பதிவேடு)', colLedger: 'ஈட்டியது (புத்தகம்)', colReceived: 'பெறப்பட்டது', colReceivable: 'இன்னும் வர வேண்டியது (புத்தகம்)', colToPost: 'பதிய வேண்டியது', colAgrees: 'பொருந்துகிறது',
    yes: 'ஆம்', no: 'இல்லை', notApproved: 'அனுமதிக்கப்படவில்லை — புத்தகத்தில் சேர்க்கப்படவில்லை', notMapped: 'தெரியவில்லை — கணக்காளர் விதியை அமைக்கவில்லை', allAgree: 'ஒவ்வொரு திட்டத்திற்கும் புத்தகம் பதிவேட்டுடன் பொருந்துகிறது.', someDiffer: 'புத்தகமும் பதிவேடும் வேறுபடுகின்றன — பதியுங்கள், அல்லது ஏன் என்று கண்டறியுங்கள்.',
    accounts: 'பதியும் கணக்குகள்: {receivable} (வர வேண்டியது), {income} (வருமானம்)', noRule: 'ஈட்டிய தள்ளுபடிகளுக்கான பதிவு விதியைக் கணக்காளர் இன்னும் அமைக்கவில்லை — எதையும் புத்தகத்தில் சேர்க்க முடியாது.',
    posted: '{count} பதிவுகள் புத்தகத்தில் சேர்க்கப்பட்டன.', nothingToPost: 'பதிய எதுவும் இல்லை — பதிவேடு ஈட்டியதைப் புத்தகம் ஏற்கனவே வைத்துள்ளது.', notPostedFor: '{scheme} பதியப்படவில்லை: {reason}',
    noSchemes: 'இன்னும் எந்தத் தள்ளுபடித் திட்டமும் பதிவாகவில்லை.',
    needMeasure: 'திட்டக் குறியீட்டையும் இரண்டு நாட்களையும் (YYYY-MM-DD) எழுதுங்கள்.', needBaseline: 'இரண்டு ஒப்பீட்டு நாட்களையும் (YYYY-MM-DD) எழுதுங்கள், அல்லது இரண்டையும் காலியாக விடுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotMeasure: 'உங்கள் பங்கு தள்ளுபடிகளைக் கணக்கிட முடியாது.', cannotRead: 'உங்கள் பங்கு கணக்குப் புத்தகத்தைப் பார்க்க முடியாது.', cannotPost: 'உங்கள் பங்கு புத்தகத்தில் பதிய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.',
  },
} as const;

export function rebateAccrualWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (REBATE_ACCRUAL_COPY[lang] as Record<string, string>)[key] ?? (REBATE_ACCRUAL_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const rebateAccrualOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => rebateAccrualWords(lang, k), out);

export interface AccrualLine {
  readonly schemeId: string; readonly supplierId: string; readonly approved: boolean; readonly registerAccruedMinor: number; readonly ledgerAccruedMinor: number;
  readonly receivedMinor: number; readonly ledgerReceivableMinor: number | null; readonly toPostMinor: number; readonly agrees: boolean;
}
export interface AccrualBooks { readonly lines: readonly AccrualLine[]; readonly accounts: { readonly receivable: string; readonly income: string } | null; readonly agrees: boolean; readonly registerAccruedMinor: number; readonly ledgerAccruedMinor: number }
export interface Measured { readonly accrual: { readonly accrued: { readonly minor: number }; readonly basisSources?: { readonly invoices?: readonly string[]; readonly notValued?: readonly unknown[] } } }
export interface PostResult { readonly posted: readonly { readonly entryId: string }[]; readonly notPosted: readonly { readonly schemeId: string; readonly reason: string }[] }

type Why = 'nobody' | 'cannotMeasure' | 'cannotRead' | 'cannotPost' | 'needMeasure' | 'needBaseline';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (s: string): boolean => DAY.test(s.trim()) && new Date(`${s.trim()}T00:00:00.000Z`).toISOString().slice(0, 10) === s.trim();

/** The accrual id is the period it measures: the same period measured again replaces it (head office keeps the history). */
export const accrualIdOf = (from: string, to: string): string => `period-${from.trim()}-to-${to.trim()}`;

export interface RebateAccrualsSession {
  readonly may: { readonly named: boolean; readonly measure: boolean; readonly books: boolean; readonly post: boolean };
  measure(f: { readonly schemeId: string; readonly from: string; readonly to: string; readonly baselineFrom: string; readonly baselineTo: string }): Promise<Outcome<Measured, Why>>;
  books(): Promise<Outcome<AccrualBooks, Why>>;
  post(): Promise<Outcome<PostResult, Why>>;
}

export function createRebateAccrualsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): RebateAccrualsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, measure: named && held.has('purchase.contract.manage'), books: named && held.has('finance.period.read'), post: named && held.has('finance.journal.post') };
  const call = makeCaller({ keyPrefix: 'rebate-accruals', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (need: 'measure' | 'books' | 'post', why: Why): { result: 'invalid'; why: Why } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why } : undefined);
  return {
    may,
    measure: async (f) => {
      const g = gate('measure', 'cannotMeasure'); if (g) return g;
      if (f.schemeId.trim() === '' || !day(f.from) || !day(f.to)) return { result: 'invalid', why: 'needMeasure' };
      const base = [f.baselineFrom.trim(), f.baselineTo.trim()];
      if ((base[0] !== '' || base[1] !== '') && !(day(base[0]!) && day(base[1]!))) return { result: 'invalid', why: 'needBaseline' };
      return call('POST', `/v1/purchase/rebate-schemes/${encodeURIComponent(f.schemeId.trim())}/accruals/${encodeURIComponent(accrualIdOf(f.from, f.to))}`, {
        periodFrom: f.from.trim(), periodTo: f.to.trim(), ...(base[0] === '' ? {} : { baselineFrom: base[0], baselineTo: base[1] }),
      });
    },
    books: async () => gate('books', 'cannotRead') ?? call('GET', '/v1/finance/rebate-accruals'),
    post: async () => gate('post', 'cannotPost') ?? call('POST', '/v1/finance/rebate-accruals/post', {}),
  };
}
