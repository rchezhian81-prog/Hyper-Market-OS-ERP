// The Scrap and recycling page (M28-FR-02 "Scrap/recycling sales and evidence" · P-08). A tested, DOM-free session over head
// office's own scrap routes (services/finance/src/scrap.ts):
//   • RECORD a disposal — cardboard, plastic, metal, e-waste, used oil, damaged or expired stock — sold, recycled, donated or
//     destroyed, with its weight, its money, the buyer, the evidence (weighbridge slip, receipt, photograph) and, for e-waste
//     and used oil, the authorised recycler's registration. Head office NEVER refuses one for missing evidence (refusing
//     pushes the sale back outside the system): it records it and flags it on the review;
//   • REVIEW a branch over a window — how many, how much money, how much weight, how much is NOT yet in the books, each
//     category's own average rate, and every finding (no evidence, no buyer, not posted, rate well below the average, sold
//     for nothing, no authorised recycler);
//   • MARK a disposal's money as taken into the books (this is what clears "not posted to finance").
// Head office re-checks every permission and every branch (another branch is refused by name); `may` only shapes what is
// offered. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { paiseOf, rupees } from './blanket-orders-session';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

export { rupees };
export type Lang = 'en' | 'ta';
/** Today in the shop's own zone (packages/calendar shop-clock), never the browser's or UTC — the form's default day. */
export const todayAtShop = (nowIso: string = new Date().toISOString(), timeZone: string = servedShopZone()): string => shopDateIn(nowIso, timeZone);

export const SCRAP_CATEGORIES = ['cardboard', 'plastic', 'metal', 'e_waste', 'used_oil', 'damaged_stock', 'expired_stock', 'other'] as const;
export const SCRAP_DISPOSALS = ['sold', 'recycled', 'donated', 'destroyed'] as const;
export type ScrapCategory = (typeof SCRAP_CATEGORIES)[number];
export type ScrapDisposal = (typeof SCRAP_DISPOSALS)[number];

export const SCRAP_COPY = {
  en: {
    title: 'Scrap and recycling', lead: 'Every carton, crate, dead freezer, can of used oil and damaged stock that leaves the shop — sold, recycled, donated or destroyed — with its weight, its money and its evidence. Money not yet in the books is shown until it is.',
    reviewH: 'Review a branch', branch: 'Branch code', from: 'From (YYYY-MM-DD)', to: 'To (YYYY-MM-DD)', show: 'Show the review',
    sales: 'Disposals', proceeds: 'Money', weight: 'Weight', unposted: 'Not yet in the books', ratesH: 'Average rate per tonne (this window)', noRates: 'No sale with a weight yet — no average to compare with.',
    findingsH: 'Questions to ask', noFindings: 'Nothing to question in this window.', perTonne: 'per tonne',
    fl_no_evidence: 'No evidence (slip, receipt or photograph)', fl_no_buyer_named: 'No buyer named', fl_not_posted_to_finance: 'Money not yet in the books',
    fl_rate_below_average: 'Rate well below this category\'s own average', fl_sold_with_no_proceeds: 'Sold, but no money recorded', fl_unauthorised_recycler: 'No authorised recycler named (required for e-waste and used oil)',
    markPosted: 'Mark as taken into the books',
    recordH: 'Record a disposal', category: 'What', disposal: 'What happened to it', kg: 'Weight (kg)', proceedsRs: 'Money received (₹)', buyer: 'Buyer (optional)',
    evidence: 'Evidence references, comma separated (optional)', recycler: 'Recycler registration (e-waste, used oil)', handledBy: 'Handled by', record: 'Record it',
    c_cardboard: 'Cardboard', c_plastic: 'Plastic', c_metal: 'Metal', c_e_waste: 'E-waste', c_used_oil: 'Used oil', c_damaged_stock: 'Damaged stock', c_expired_stock: 'Expired stock', c_other: 'Other',
    d_sold: 'Sold', d_recycled: 'Recycled', d_donated: 'Donated', d_destroyed: 'Destroyed',
    recorded: 'Recorded at head office. It is NOT in the books until finance takes it up — it shows on the review until then.', posted: 'Marked as taken into the books.',
    needReview: 'Write the branch code and both days (YYYY-MM-DD), from on or before to.', needRecord: 'Fill in the branch, what it was, what happened to it, the weight in kg, the money in rupees (0 if none) and who handled it.',
    nobody: 'Nobody is signed in on this screen.', cannotReview: 'Your role cannot read the scrap review.', cannotRecord: 'Your role cannot record scrap disposals.',
    // Round B · OB-515 (owner, 28 Oct 2026): the owner and the accountant record a scrap sale; a store manager reviews.
    recordNotYours: 'You can read the review, but recording a scrap or recycling sale is for the owner or the accountant (the owner\'s decision) — your role does not hold it, so the form is not shown.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'கழிவுப் பொருள் மற்றும் மறுசுழற்சி', lead: 'கடையை விட்டுச் செல்லும் ஒவ்வொரு அட்டைப்பெட்டி, கூடை, பழுதான உறைவிப்பான், பயன்படுத்திய எண்ணெய், சேதமான சரக்கு — விற்றது, மறுசுழற்சி, நன்கொடை அல்லது அழித்தது — அதன் எடை, பணம், சான்றுடன். கணக்கில் சேராத பணம் சேரும் வரை காட்டப்படும்.',
    reviewH: 'ஒரு கிளையை மதிப்பாய்வு செய்', branch: 'கிளைக் குறியீடு', from: 'முதல் (YYYY-MM-DD)', to: 'வரை (YYYY-MM-DD)', show: 'மதிப்பாய்வைக் காட்டு',
    sales: 'அகற்றல்கள்', proceeds: 'பணம்', weight: 'எடை', unposted: 'இன்னும் கணக்கில் சேரவில்லை', ratesH: 'டன்னுக்குச் சராசரி விலை (இந்தக் காலம்)', noRates: 'எடையுடன் விற்பனை இன்னும் இல்லை — ஒப்பிடச் சராசரி இல்லை.',
    findingsH: 'கேட்க வேண்டிய கேள்விகள்', noFindings: 'இந்தக் காலத்தில் கேள்விக்குரியது எதுவும் இல்லை.', perTonne: 'டன்னுக்கு',
    fl_no_evidence: 'சான்று இல்லை (சீட்டு, ரசீது அல்லது புகைப்படம்)', fl_no_buyer_named: 'வாங்குபவர் பெயர் இல்லை', fl_not_posted_to_finance: 'பணம் இன்னும் கணக்கில் சேரவில்லை',
    fl_rate_below_average: 'இந்த வகையின் சொந்தச் சராசரியை விட மிகக் குறைந்த விலை', fl_sold_with_no_proceeds: 'விற்றது, ஆனால் பணம் பதிவாகவில்லை', fl_unauthorised_recycler: 'அங்கீகரிக்கப்பட்ட மறுசுழற்சியாளர் பெயர் இல்லை (மின்-கழிவு, பயன்படுத்திய எண்ணெய்க்குக் கட்டாயம்)',
    markPosted: 'கணக்கில் சேர்த்ததாகக் குறி',
    recordH: 'ஒரு அகற்றலைப் பதிவு செய்', category: 'என்ன', disposal: 'அதற்கு என்ன ஆனது', kg: 'எடை (கிலோ)', proceedsRs: 'பெற்ற பணம் (₹)', buyer: 'வாங்குபவர் (விருப்பம்)',
    evidence: 'சான்றுக் குறிப்புகள், காற்புள்ளியால் பிரித்து (விருப்பம்)', recycler: 'மறுசுழற்சியாளர் பதிவு எண் (மின்-கழிவு, எண்ணெய்)', handledBy: 'கையாண்டவர்', record: 'பதிவு செய்',
    c_cardboard: 'அட்டைப்பெட்டி', c_plastic: 'பிளாஸ்டிக்', c_metal: 'உலோகம்', c_e_waste: 'மின்-கழிவு', c_used_oil: 'பயன்படுத்திய எண்ணெய்', c_damaged_stock: 'சேதமான சரக்கு', c_expired_stock: 'காலாவதியான சரக்கு', c_other: 'மற்றவை',
    d_sold: 'விற்றது', d_recycled: 'மறுசுழற்சி', d_donated: 'நன்கொடை', d_destroyed: 'அழித்தது',
    recorded: 'தலைமை அலுவலகத்தில் பதிவானது. நிதித்துறை எடுக்கும் வரை இது கணக்கில் இல்லை — அதுவரை மதிப்பாய்வில் காட்டப்படும்.', posted: 'கணக்கில் சேர்த்ததாகக் குறிக்கப்பட்டது.',
    needReview: 'கிளைக் குறியீட்டையும் இரண்டு நாட்களையும் (YYYY-MM-DD) எழுதுங்கள், முதல் நாள் வரை நாளுக்கு முன்.', needRecord: 'கிளை, என்ன, அதற்கு என்ன ஆனது, கிலோவில் எடை, ரூபாயில் பணம் (இல்லையெனில் 0), கையாண்டவர் ஆகியவற்றை நிரப்புங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotReview: 'உங்கள் பணி கழிவு மதிப்பாய்வைப் படிக்க முடியாது.', cannotRecord: 'உங்கள் பணி கழிவு அகற்றல்களைப் பதிவு செய்ய முடியாது.',
    recordNotYours: 'நீங்கள் மதிப்பாய்வைப் படிக்கலாம்; ஆனால் கழிவு அல்லது மறுசுழற்சி விற்பனையைப் பதிவு செய்வது உரிமையாளர் அல்லது கணக்காளரின் பணி (உரிமையாளரின் முடிவு) — உங்கள் பணிக்கு அந்த அனுமதி இல்லை, எனவே படிவம் காட்டப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const scrapWords = (lang: Lang, key: string): string =>
  (SCRAP_COPY[lang] as Record<string, string>)[key] ?? (SCRAP_COPY.en as Record<string, string>)[key] ?? key;

export interface ScrapFinding { readonly scrapId: string; readonly category: string; readonly flag: string; readonly proceedsMinor: number; readonly detail: string }
export interface ScrapReview {
  readonly branchId: string; readonly from: string; readonly to: string; readonly sales: number; readonly totalProceedsMinor: number; readonly totalGrams: number;
  readonly unpostedMinor: number; readonly findings: readonly ScrapFinding[]; readonly ratesPerTonneMinor: Readonly<Record<string, number>>; readonly detail: string; readonly asAt: string;
}
export interface ReviewForm { readonly branchId: string; readonly from: string; readonly to: string }
export interface RecordForm {
  readonly branchId: string; readonly category: string; readonly disposal: string; readonly kg: string; readonly proceedsRupees: string;
  readonly buyerName: string; readonly evidence: string; readonly recyclerRegistration: string; readonly handledBy: string;
}

type Why = 'nobody' | 'cannotReview' | 'cannotRecord' | 'needReview' | 'needRecord';
type Done<T = Record<string, unknown>> = Promise<Outcome<T, Why>>;

export interface ScrapSession {
  readonly may: { readonly named: boolean; readonly review: boolean; readonly record: boolean };
  readonly userId: string | undefined;
  review(form: ReviewForm): Done<ScrapReview>;
  record(form: RecordForm): Done<{ readonly scrapId: string; readonly postedToFinance: boolean }>;
  markPosted(scrapId: string): Done<{ readonly scrapId: string; readonly postedToFinance: boolean }>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const seg = (s: string): string => encodeURIComponent(s.trim());

/** "12.5" kg → 12,500 grams (scrap is weighed; up to three decimals). Anything else → null. */
export function gramsOf(kgText: string): number | null {
  const v = kgText.replace(/[,\s]/g, '').replace(/kg$/i, '');
  if (!/^\d+(\.\d{1,3})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
}
/** 12,500 grams → "12.5 kg". */
export const kgWords = (grams: number): string => `${(grams / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg`;

export const scrapOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => scrapWords(lang, k), out);
  const v = (out.value ?? {}) as Record<string, unknown>;
  return scrapWords(lang, v['postedToFinance'] === true ? 'posted' : 'recorded');
};

export function createScrapSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newScrapId?: () => string;
}): ScrapSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, review: named && held.has('scrap.review.read'), record: named && held.has('scrap.sale.record') };
  const call = makeCaller({ keyPrefix: 'scrap', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const scrapIdOf = input.newScrapId ?? (() => newId('scrap'));
  const gate = (need: 'review' | 'record', why: Why): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why } : undefined;
  return {
    may,
    userId: input.viewer?.userId,
    review: async (f) => {
      const no = gate('review', 'cannotReview'); if (no !== undefined) return no;
      const branchId = f.branchId.trim(); const from = f.from.trim(); const to = f.to.trim();
      if (branchId === '' || !DAY.test(from) || !DAY.test(to) || from > to) return { result: 'invalid', why: 'needReview' };
      return call('GET', `/v1/scrap/review?branchId=${seg(branchId)}&from=${from}&to=${to}`);
    },
    record: async (f) => {
      const no = gate('record', 'cannotRecord'); if (no !== undefined) return no;
      const grams = gramsOf(f.kg);
      const proceedsMinor = paiseOf(f.proceedsRupees.trim() === '' ? '' : f.proceedsRupees);
      if (f.branchId.trim() === '' || !(SCRAP_CATEGORIES as readonly string[]).includes(f.category) || !(SCRAP_DISPOSALS as readonly string[]).includes(f.disposal)
        || grams === null || proceedsMinor === null || f.handledBy.trim() === '') return { result: 'invalid', why: 'needRecord' };
      const evidenceRefs = f.evidence.split(',').map((r) => r.trim()).filter((r) => r !== '');
      return call('POST', '/v1/scrap/sales', {
        scrapId: scrapIdOf(), branchId: f.branchId.trim(), category: f.category, disposal: f.disposal, grams, proceedsMinor, handledBy: f.handledBy.trim(),
        ...(f.buyerName.trim() === '' ? {} : { buyerName: f.buyerName.trim() }),
        ...(evidenceRefs.length === 0 ? {} : { evidenceRefs }),
        ...(f.recyclerRegistration.trim() === '' ? {} : { recyclerRegistration: f.recyclerRegistration.trim() }),
      });
    },
    markPosted: async (scrapId) => {
      const no = gate('record', 'cannotRecord'); if (no !== undefined) return no;
      return call('POST', `/v1/scrap/sales/${seg(scrapId)}/posted`, {});
    },
  };
}
