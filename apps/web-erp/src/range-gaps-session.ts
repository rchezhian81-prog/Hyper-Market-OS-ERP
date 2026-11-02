// Range gaps and private label (W3 · D02-FR-04 · OB-319, owner, 23 Oct 2026, in writing: "a gap report from our own facts —
// short-picks, failed substitutions and no-result searches per category and price band — plus private-label margin against
// branded") — a tested, DOM-free session for the report on the Store groups and seasons page, which no screen read before.
//   GET /v1/merchandising/range-gaps?from=YYYY-MM-DD&to=YYYY-MM-DD&bandEdgesMinor=5000,20000
// Every figure is head office's own fold of its own records; nothing here is typed in except the window and the price bands
// the reader wants (in rupees; none typed is ONE band, "all prices", and head office says so). A margin head office cannot
// work out (a product with no known cost) is "not known", named — never zero. Read only, `merchandising.range.read`.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOfTyped } from './price-checks-session';

export type Lang = 'en' | 'ta';

export interface GapLine { readonly categoryId: string | null; readonly band: string; readonly shortPicks: number; readonly failedSubstitutions: number; readonly products: readonly string[] }
export interface LabelSide { readonly netSalesMinor: number; readonly marginMinor: number | null; readonly marginBps: number | null; readonly products: number; readonly costNotKnownFor: readonly string[] }
export interface RangeGapsRead {
  readonly from: string; readonly to: string; readonly bands: readonly string[]; readonly bandsChosenBy: string;
  readonly gaps: readonly GapLine[]; readonly searches: readonly { readonly words: string; readonly count: number }[];
  readonly privateLabel: readonly { readonly categoryId: string | null; readonly own: LabelSide; readonly branded: LabelSide }[];
  readonly privateLabelProducts: number; readonly totals: { readonly shortPicks: number; readonly failedSubstitutions: number; readonly searchesWithNoResult: number };
}

export const RANGE_GAPS_COPY = {
  en: {
    h: 'Range gaps and own brand', lead: 'Demand the shop saw and could not serve — items pickers could not find, substitutes customers turned down and app searches that found nothing — by category and price band. Beside it, our own-brand margin against branded. Every figure is head office\'s own record; nothing changes from reading it.',
    from: 'From', to: 'To', bands: 'Price bands (₹ edges, e.g. 50, 200 — blank for all prices)', show: 'Show the report',
    cardShort: 'Short-picks', cardFailed: 'Substitutes turned down', cardSearch: 'Searches with no result', cardOwn: 'Own-brand products',
    gapsH: 'Where demand went unserved', colCategory: 'Category', colBand: 'Price band', colShort: 'Short-picks', colFailed: 'Substitutes turned down', colProducts: 'Products',
    noGaps: 'No short-pick or turned-down substitute in this window.', noCategory: 'no category on record', oneBand: 'One band, all prices — no bands were typed.',
    searchH: 'App searches that found nothing', colWords: 'Words searched', colCount: 'Times', noSearches: 'No app search came back empty in this window.',
    plH: 'Own brand against branded', colOwn: 'Own brand margin', colBranded: 'Branded margin', colOwnSales: 'Own brand sales', colBrandedSales: 'Branded sales',
    notKnown: 'not known — no cost for', nothingSold: 'nothing sold', noPl: 'Nothing was sold in this window.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the range report.', badDates: 'Give a from and a to date, the to date on or after the from date.', badBands: 'Type the band edges in rupees, rising, e.g. 50, 200.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.', reading: 'Reading from head office…',
  },
  ta: {
    h: 'வரிசை இடைவெளிகளும் சொந்த பிராண்டும்', lead: 'கடை கண்டும் நிறைவேற்ற முடியாத தேவை — எடுப்பவர்கள் கண்டுபிடிக்க முடியாத பொருட்கள், வாடிக்கையாளர்கள் மறுத்த மாற்றுப் பொருட்கள், எதுவும் கிடைக்காத செயலித் தேடல்கள் — வகை மற்றும் விலைப் பட்டை வாரியாக. அருகில், பிராண்டட் பொருட்களுக்கு எதிராக நம் சொந்த பிராண்ட் லாபம். ஒவ்வொரு எண்ணும் தலைமை அலுவலகத்தின் சொந்தப் பதிவு; படிப்பதால் எதுவும் மாறாது.',
    from: 'முதல்', to: 'வரை', bands: 'விலைப் பட்டைகள் (₹ எல்லைகள், எ.கா. 50, 200 — எல்லா விலைகளுக்கும் காலியாக விடுங்கள்)', show: 'அறிக்கையைக் காட்டு',
    cardShort: 'எடுக்க முடியாதவை', cardFailed: 'மறுக்கப்பட்ட மாற்றுகள்', cardSearch: 'முடிவில்லாத தேடல்கள்', cardOwn: 'சொந்த பிராண்ட் பொருட்கள்',
    gapsH: 'தேவை நிறைவேறாத இடங்கள்', colCategory: 'வகை', colBand: 'விலைப் பட்டை', colShort: 'எடுக்க முடியாதவை', colFailed: 'மறுக்கப்பட்ட மாற்றுகள்', colProducts: 'பொருட்கள்',
    noGaps: 'இந்தக் காலத்தில் எடுக்க முடியாதது அல்லது மறுக்கப்பட்ட மாற்று இல்லை.', noCategory: 'வகை பதிவில் இல்லை', oneBand: 'ஒரே பட்டை, எல்லா விலைகளும் — பட்டைகள் தட்டச்சு செய்யப்படவில்லை.',
    searchH: 'எதுவும் கிடைக்காத செயலித் தேடல்கள்', colWords: 'தேடிய சொற்கள்', colCount: 'முறை', noSearches: 'இந்தக் காலத்தில் எந்தச் செயலித் தேடலும் காலியாக வரவில்லை.',
    plH: 'பிராண்டட்டுக்கு எதிராகச் சொந்த பிராண்ட்', colOwn: 'சொந்த பிராண்ட் லாபம்', colBranded: 'பிராண்டட் லாபம்', colOwnSales: 'சொந்த பிராண்ட் விற்பனை', colBrandedSales: 'பிராண்டட் விற்பனை',
    notKnown: 'தெரியவில்லை — அடக்கவிலை இல்லாதவை', nothingSold: 'எதுவும் விற்கவில்லை', noPl: 'இந்தக் காலத்தில் எதுவும் விற்கவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கால் வரிசை அறிக்கையைப் பார்க்க முடியாது.', badDates: 'முதல் மற்றும் வரை தேதிகளைக் கொடுங்கள், வரை தேதி முதல் தேதிக்குப் பிறகு அல்லது அதே நாள்.', badBands: 'பட்டை எல்லைகளை ரூபாயில், ஏறுவரிசையில் தட்டச்சு செய்யுங்கள், எ.கா. 50, 200.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const rangeGapsWords = (lang: Lang, key: string): string =>
  (RANGE_GAPS_COPY[lang] as Record<string, string>)[key] ?? (RANGE_GAPS_COPY.en as Record<string, string>)[key] ?? key;
export const rangeGapsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => rangeGapsWords(lang, k), out);

/** The band edges typed in rupees ("50, 200") as paise, rising — or undefined. Blank is no bands (one band, all prices). */
export function bandEdgesOf(typed: string): readonly number[] | undefined {
  const parts = typed.split(/[,\s]+/).map((p) => p.trim()).filter((p) => p !== '');
  const edges: number[] = [];
  for (const p of parts) {
    const minor = paiseOfTyped(p);
    if (minor === undefined || minor <= 0 || (edges.length > 0 && minor <= edges[edges.length - 1]!)) return undefined;
    edges.push(minor);
  }
  return edges;
}

type Why = 'nobody' | 'cannotRead' | 'badDates' | 'badBands';

export interface RangeGapsSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  read(input: { readonly from: string; readonly to: string; readonly bands: string }): Promise<Outcome<RangeGapsRead, Why>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const side = (v: unknown): LabelSide => {
  const s = isObj(v) ? v : {};
  return { netSalesMinor: num(s['netSalesMinor']), marginMinor: numOrNull(s['marginMinor']), marginBps: numOrNull(s['marginBps']), products: num(s['products']), costNotKnownFor: strings(s['costNotKnownFor']) };
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function createRangeGapsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): RangeGapsSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && (input.viewer?.permissions ?? []).includes('merchandising.range.read') };
  const call = makeCaller({ keyPrefix: 'range-gaps', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): Outcome<never, Why> => ({ result: 'invalid', why });
  return {
    may,
    read: async (q) => {
      if (!named) return no('nobody');
      if (!may.read) return no('cannotRead');
      const from = q.from.trim(); const to = q.to.trim();
      if (!DAY.test(from) || !DAY.test(to) || to < from) return no('badDates');
      const edges = bandEdgesOf(q.bands);
      if (edges === undefined) return no('badBands');
      const out = await call<Record<string, unknown>>('GET', `/v1/merchandising/range-gaps?from=${from}&to=${to}${edges.length === 0 ? '' : `&bandEdgesMinor=${edges.join(',')}`}`);
      if (out.result !== 'ok') return out;
      const v = out.value;
      const totals = isObj(v['totals']) ? v['totals'] : {};
      return {
        result: 'ok', value: {
          from: typeof v['from'] === 'string' ? v['from'] : from, to: typeof v['to'] === 'string' ? v['to'] : to, bands: strings(v['bands']), bandsChosenBy: typeof v['bandsChosenBy'] === 'string' ? v['bandsChosenBy'] : '',
          gaps: (Array.isArray(v['gaps']) ? v['gaps'] : []).filter(isObj).map((g) => ({ categoryId: typeof g['categoryId'] === 'string' ? g['categoryId'] : null, band: typeof g['band'] === 'string' ? g['band'] : '', shortPicks: num(g['shortPicks']), failedSubstitutions: num(g['failedSubstitutions']), products: strings(g['products']) })),
          searches: (Array.isArray(v['searchesWithNoResult']) ? v['searchesWithNoResult'] : []).filter(isObj).map((s) => ({ words: typeof s['words'] === 'string' ? s['words'] : '', count: num(s['count']) })),
          privateLabel: (Array.isArray(v['privateLabel']) ? v['privateLabel'] : []).filter(isObj).map((r) => ({ categoryId: typeof r['categoryId'] === 'string' ? r['categoryId'] : null, own: side(r['privateLabel']), branded: side(r['branded']) })),
          privateLabelProducts: num(v['privateLabelProducts']),
          totals: { shortPicks: num(totals['shortPicks']), failedSubstitutions: num(totals['failedSubstitutions']), searchesWithNoResult: num(totals['searchesWithNoResult']) },
        },
      };
    },
  };
}
