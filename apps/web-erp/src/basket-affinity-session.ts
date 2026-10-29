// D-23 (R4, signed OB-227) — the Bought together page's tested, DOM-free session. A thin client over head office's own
// read of the banked bills (GET /v1/reporting/basket-affinity): the pairs bought together more often than chance, each
// with its basket count, support, confidence and lift; the minimum number of baskets is the reader's own input (there is
// no default). A promotion made from a pair is a DRAFT sent, as the signed-in person, to the EXISTING promotion
// definition route — it applies only after the existing launch approval. Nothing is written on open.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';
import { instantOfTyped, servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';
export interface PairView {
  readonly productA: string; readonly productB: string; readonly basketCount: number; readonly basketsWithA: number; readonly basketsWithB: number;
  readonly support: number; readonly confidenceAtoB: number; readonly confidenceBtoA: number; readonly lift: number;
  readonly suggestions: readonly { readonly kind: string; readonly draft: true; readonly detail: string }[];
}
export interface AffinityView {
  readonly from: string; readonly to: string; readonly department: string | null; readonly basketCount: number; readonly minBaskets: number;
  readonly pairs: readonly PairView[]; readonly belowMinimum: number; readonly returnsTakenOut: number; readonly productsWithoutCategory: number; readonly emptiedByReturns: number;
}

export const AFFINITY_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Bought together',
    lead: 'From the bills the shop banked: the pairs of products bought together more often than chance. Returns are taken out first. Every suggestion is a draft — nothing changes on the shelf or the till by itself.',
    from: 'From', to: 'To', minBaskets: 'Minimum baskets a pair must be in', department: 'Department (category code, optional)', show: 'Show the pairs',
    pairsH: 'Pairs bought together', baskets: 'baskets', support: 'support', confidence: 'confidence', lift: 'lift', suggestions: 'Draft suggestions: place side by side · bundle · promotion',
    percent: 'Promotion % off', startsAt: 'Starts', endsAt: 'Ends', draftPromo: 'Make a draft promotion',
    drafted: 'Drafted as a promotion — it is NOT live. It applies only after the promotion launch approval.',
    counted: 'bills counted', belowMinimum: 'pairs above chance seen in too few baskets (not shown)', returnsTakenOut: 'returns taken out', withoutCategory: 'products with no category (left out of the department)',
    noPairs: 'No pair is bought together more often than chance in this period at this minimum.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read reports.', cannotDraft: 'Your role cannot draft a promotion.',
    needWindow: 'Fill in the from and to days and the minimum baskets (a whole number of at least 1). There is no default. Nothing was sent.',
    needPromo: 'Give the % off (1 to 100) and the start and end days. Nothing was sent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'சேர்ந்து வாங்கப்பட்டவை',
    lead: 'கடை வங்கியில் சேர்த்த பில்களிலிருந்து: தற்செயலை விட அதிகமாக சேர்ந்து வாங்கப்பட்ட பொருள் ஜோடிகள். முதலில் திரும்பியவை நீக்கப்படும். ஒவ்வொரு பரிந்துரையும் வரைவு — அலமாரியிலோ கவுண்டரிலோ எதுவும் தானாக மாறாது.',
    from: 'முதல்', to: 'வரை', minBaskets: 'ஒரு ஜோடி இருக்க வேண்டிய குறைந்தபட்ச கூடைகள்', department: 'துறை (வகைக் குறியீடு, விருப்பம்)', show: 'ஜோடிகளைக் காட்டு',
    pairsH: 'சேர்ந்து வாங்கப்பட்ட ஜோடிகள்', baskets: 'கூடைகள்', support: 'ஆதரவு', confidence: 'நம்பகத்தன்மை', lift: 'உயர்வு', suggestions: 'வரைவுப் பரிந்துரைகள்: அருகருகே வை · தொகுப்பு · சலுகை',
    percent: 'சலுகை % தள்ளுபடி', startsAt: 'தொடக்கம்', endsAt: 'முடிவு', draftPromo: 'வரைவுச் சலுகையை உருவாக்கு',
    drafted: 'சலுகையாக வரைவு செய்யப்பட்டது — இது நடைமுறையில் இல்லை. சலுகை தொடக்க ஒப்புதலுக்குப் பிறகே பொருந்தும்.',
    counted: 'கணக்கிட்ட பில்கள்', belowMinimum: 'மிகக் குறைந்த கூடைகளில் காணப்பட்ட ஜோடிகள் (காட்டப்படவில்லை)', returnsTakenOut: 'நீக்கப்பட்ட திருப்பங்கள்', withoutCategory: 'வகை இல்லாத பொருட்கள் (துறையிலிருந்து விடப்பட்டன)',
    noPairs: 'இந்தக் காலத்தில் இந்தக் குறைந்தபட்சத்தில் தற்செயலை விட அதிகமாக சேர்ந்து வாங்கப்பட்ட ஜோடி இல்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு அறிக்கைகளைப் படிக்க முடியாது.', cannotDraft: 'உங்கள் பங்கு சலுகையை வரைவு செய்ய முடியாது.',
    needWindow: 'முதல், வரை நாட்களையும் குறைந்தபட்ச கூடைகளையும் (குறைந்தது 1) நிரப்பவும். இயல்பு மதிப்பு இல்லை. எதுவும் அனுப்பப்படவில்லை.',
    needPromo: '% தள்ளுபடி (1 முதல் 100), தொடக்க மற்றும் முடிவு நாட்களைக் கொடுக்கவும். எதுவும் அனுப்பப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type AffinityCopyKey = keyof typeof AFFINITY_COPY.en;
export const affinityWords = (lang: Lang, key: AffinityCopyKey | string): string => (AFFINITY_COPY[lang] as Record<string, string>)[key] ?? (AFFINITY_COPY.en as Record<string, string>)[key] ?? key;
export const affinityOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => affinityWords(lang, k), out);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface AffinitySession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly draft: boolean };
  pairs(from: string, to: string, minBaskets: string, department: string): Promise<Outcome<AffinityView>>;
  draftPromotion(pair: PairView, percent: string, startsAt: string, endsAt: string): Promise<Outcome<{ readonly promotionId: string; readonly status: string }>>;
}

export function createAffinitySession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly timeZone?: string }): AffinitySession {
  const zone = input.timeZone ?? servedShopZone();
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('reporting.report.read'), draft: named && perms.has('promotion.launch') };
  const call = makeCaller({ keyPrefix: 'affinity', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  return {
    may,
    pairs: async (from, to, minBaskets, department) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      const min = Number(minBaskets.trim());
      if (!DAY.test(from.trim()) || !DAY.test(to.trim()) || minBaskets.trim() === '' || !Number.isInteger(min) || min < 1) return { result: 'invalid', why: 'needWindow' };
      const dept = department.trim();
      return call('GET', `/v1/reporting/basket-affinity?from=${enc(from.trim())}&to=${enc(to.trim())}&minBaskets=${min}${dept === '' ? '' : `&department=${enc(dept)}`}`);
    },
    draftPromotion: async (pair, percent, startsAt, endsAt) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.draft) return { result: 'invalid', why: 'cannotDraft' };
      const p = Number(percent.trim());
      if (!Number.isFinite(p) || p <= 0 || p > 100 || !DAY.test(startsAt.trim()) || !DAY.test(endsAt.trim()) || endsAt.trim() < startsAt.trim()) return { result: 'invalid', why: 'needPromo' };
      // OB-610: the typed dates are whole SHOP days — 00:00:00 on the first to 23:59:59 on the last, in the shop's zone (the
      // one the store computer served this page) — never UTC day edges (which ran the offer 05:30 to 05:29 the day after).
      const from = instantOfTyped(`${startsAt.trim()}T00:00`, zone);
      const until = instantOfTyped(`${endsAt.trim()}T23:59:59`, zone);
      if (from === '' || until === '') return { result: 'invalid', why: 'needPromo' };
      return call('POST', `/v1/promotions/${enc(newId('aff'))}/definition`, {
        kind: 'percent_off', percentBps: Math.round(p * 100), productIds: [pair.productA, pair.productB],
        startsAt: from, endsAt: until,
      });
    },
  };
}
