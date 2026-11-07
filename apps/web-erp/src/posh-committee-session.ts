// The Internal Committee's own page for its annual report (Round 4c · R2 addendum C20 · POSH Act s.21 · OB-154 · OB-157 ·
// OB-165) — a tested, DOM-free session. The committee MAKES the year's report from its register (`POST
// /v1/hr/posh/annual-reports/:year`, `posh.report.generate` — the committee's alone) and reads it back (`GET …/:year`); which
// ended years are due or overdue comes from `GET /v1/hr/posh/annual-report-status`. COUNTS ONLY: this page never shows a
// complaint, a name or a summary, and head office seals every make and read into the committee's access log. A report already
// recorded as filed stands (head office refuses to make it again). The OWNER records the filing on his own page (Committee
// annual report). Head office's own sentences stay in English (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const POSH_COMMITTEE_COPY = {
  en: {
    title: 'Committee: make the annual report',
    lead: 'The Internal Committee makes its report for each calendar year from its own register — counts only, never a complaint or a name — for the owner to file with the District Officer by 31 January. Every make and read is recorded in the committee\'s access log.',
    yearsH: 'Years to report', none: 'No ended year is waiting for a report.',
    year: 'Year', dueBy: 'due by', due: 'due', overdue: 'OVERDUE', made: 'made', notMade: 'not made yet', filed: 'filed with the District Officer on',
    make: 'Make the report', show: 'Show the report', makeAnother: 'Make it again from the register now',
    pendingAtStart: 'Open on 1 January', received: 'Received in the year', disposed: 'Disposed of in the year', pendingAtEnd: 'Still open on 31 December',
    upheld: 'upheld', not_upheld: 'not upheld', conciliation: 'settled by conciliation', withdrawn: 'withdrawn',
    madeBy: 'made by', law: 'Law', note: 'Note',
    otherYearH: 'Another year', otherYear: 'Year (YYYY)',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Only the Internal Committee makes and reads this report.',
    badYear: 'Write the year as four figures, e.g. 2026.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was made or read.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'குழு: ஆண்டு அறிக்கை தயாரி',
    lead: 'உள் குழு ஒவ்வொரு நாள்காட்டி ஆண்டுக்கான அறிக்கையைத் தனது பதிவேட்டிலிருந்து தயாரிக்கிறது — எண்ணிக்கைகள் மட்டும், எந்தப் புகாரோ பெயரோ அல்ல — உரிமையாளர் ஜனவரி 31-க்குள் மாவட்ட அலுவலரிடம் சமர்ப்பிக்க. ஒவ்வொரு தயாரிப்பும் வாசிப்பும் குழுவின் அணுகல் பதிவில் பதிவாகும்.',
    yearsH: 'அறிக்கையிட வேண்டிய ஆண்டுகள்', none: 'முடிந்த எந்த ஆண்டும் அறிக்கைக்காகக் காத்திருக்கவில்லை.',
    year: 'ஆண்டு', dueBy: 'கடைசி நாள்', due: 'நிலுவை', overdue: 'தாமதம்', made: 'தயாரிக்கப்பட்டது', notMade: 'இன்னும் தயாரிக்கப்படவில்லை', filed: 'மாவட்ட அலுவலரிடம் சமர்ப்பித்த நாள்',
    make: 'அறிக்கையைத் தயாரி', show: 'அறிக்கையைக் காட்டு', makeAnother: 'பதிவேட்டிலிருந்து இப்போது மீண்டும் தயாரி',
    pendingAtStart: 'ஜனவரி 1 அன்று நிலுவையில்', received: 'ஆண்டில் பெறப்பட்டவை', disposed: 'ஆண்டில் முடிக்கப்பட்டவை', pendingAtEnd: 'டிசம்பர் 31 அன்று நிலுவையில்',
    upheld: 'உறுதிசெய்யப்பட்டவை', not_upheld: 'உறுதிசெய்யப்படாதவை', conciliation: 'சமரசத்தால் தீர்க்கப்பட்டவை', withdrawn: 'திரும்பப் பெறப்பட்டவை',
    madeBy: 'தயாரித்தவர்', law: 'சட்டம்', note: 'குறிப்பு',
    otherYearH: 'வேறு ஆண்டு', otherYear: 'ஆண்டு (YYYY)',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உள் குழு மட்டுமே இந்த அறிக்கையைத் தயாரித்துப் படிக்கிறது.',
    badYear: 'ஆண்டை நான்கு எண்களாக எழுதுங்கள், உ-ம் 2026.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் தயாரிக்கப்படவில்லை, படிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const poshCommitteeWords = (lang: Lang, key: string): string =>
  (POSH_COMMITTEE_COPY[lang] as Record<string, string>)[key] ?? (POSH_COMMITTEE_COPY.en as Record<string, string>)[key] ?? key;
export const poshCommitteeOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => poshCommitteeWords(lang, k), out);

export const POSH_OUTCOME_KEYS = ['upheld', 'not_upheld', 'conciliation', 'withdrawn'] as const;
export interface ReportYear { readonly year: number; readonly dueBy: string; readonly state: 'due' | 'overdue' | 'filed'; readonly made: boolean; readonly filedOn?: string }
export interface AnnualReport {
  readonly year: number; readonly pendingAtStart: number; readonly receivedInYear: number; readonly disposedInYear: number; readonly pendingAtEnd: number;
  readonly disposedByOutcome: Readonly<Record<string, number>>; readonly generatedAt: string; readonly generatedBy: string; readonly law: string; readonly formatNote: string;
}

type Why = 'nobody' | 'cannotRead' | 'badYear';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isYear = (y: number): boolean => Number.isInteger(y) && y >= 2000 && y <= 2999;

function reportOf(raw: unknown): AnnualReport | undefined {
  if (!isObj(raw) || typeof raw['year'] !== 'number') return undefined;
  const by = isObj(raw['disposedByOutcome']) ? raw['disposedByOutcome'] : {};
  return {
    year: raw['year'], pendingAtStart: num(raw['pendingAtStart']), receivedInYear: num(raw['receivedInYear']), disposedInYear: num(raw['disposedInYear']), pendingAtEnd: num(raw['pendingAtEnd']),
    disposedByOutcome: Object.fromEntries(POSH_OUTCOME_KEYS.map((k) => [k, num(by[k])])), generatedAt: str(raw['generatedAt']), generatedBy: str(raw['generatedBy']), law: str(raw['law']), formatNote: str(raw['formatNote']),
  };
}

export interface PoshCommitteeSession {
  readonly may: { readonly named: boolean; readonly committee: boolean };
  years(): Done<readonly ReportYear[]>;
  make(year: number): Done<AnnualReport>;
  read(year: number): Done<AnnualReport>;
}

export function createPoshCommitteeSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): PoshCommitteeSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const committee = named && held.has('posh.report.generate') && held.has('posh.report.read');
  const call = makeCaller({ keyPrefix: 'posh', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const gate = (year?: number): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !committee ? { result: 'invalid', why: 'cannotRead' } : year !== undefined && !isYear(year) ? { result: 'invalid', why: 'badYear' } : undefined;
  return {
    may: { named, committee },
    years: async () => {
      const g = gate(); if (g) return g;
      const out = await call<{ exceptions?: unknown[]; filed?: unknown[] }>('GET', '/v1/hr/posh/annual-report-status');
      if (out.result !== 'ok') return out;
      const open = (out.value.exceptions ?? []).flatMap((e): ReportYear[] => (isObj(e) && typeof e['year'] === 'number'
        ? [{ year: e['year'], dueBy: str(e['dueBy']), state: e['state'] === 'overdue' ? 'overdue' : 'due', made: e['generated'] === true }] : []));
      const filed = (out.value.filed ?? []).flatMap((f): ReportYear[] => (isObj(f) && typeof f['year'] === 'number'
        ? [{ year: f['year'], dueBy: `${f['year'] + 1}-01-31`, state: 'filed', made: true, filedOn: str(f['filedOn']) }] : []));
      return { result: 'ok', value: [...open, ...filed].sort((a, b) => b.year - a.year) };
    },
    make: async (year) => {
      const g = gate(year); if (g) return g;
      const out = await call<{ report?: unknown }>('POST', `/v1/hr/posh/annual-reports/${year}`, {});
      if (out.result !== 'ok') return out;
      const r = reportOf(out.value.report);
      return r === undefined ? { result: 'lost_link' } : { result: 'ok', value: r };
    },
    read: async (year) => {
      const g = gate(year); if (g) return g;
      const out = await call<{ report?: unknown }>('GET', `/v1/hr/posh/annual-reports/${year}`);
      if (out.result !== 'ok') return out;
      const r = reportOf(out.value.report);
      return r === undefined ? { result: 'lost_link' } : { result: 'ok', value: r };
    },
  };
}
