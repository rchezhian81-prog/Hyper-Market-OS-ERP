// Markdowns and the competitor rule (W3 · D06-FR-05 "markdown ladder and competitor capture") — a tested, DOM-free session
// for the screens that, until now, could not reach head office's markdown routes:
//   • PROPOSE a markdown for a near-expiry batch (the Expiry page) — `POST /v1/pricing/markdown/propose` { items: [{ productId,
//     batchId?, remainingShelfLifeDays, onHandMinor, currentPriceMinor, avgDailyDemand? }] }. ADVISORY ONLY: it changes no
//     price. The price it proposes is today's shelf price of record (`GET /v1/prices/list/:id/resolve`) unless the person
//     types one, and a blank selling rate is head office's own, from the store's sales.
//   • READ the clearance suggestions (the Expiry page) — `GET /v1/pricing/clearance-markdowns?storeId=` — the same ladder over
//     every clearance product's batches; also advisory only.
//   • SEND a proposal for approval — never from here: `priceChangeLink` opens "Change a price" on Products and prices holding
//     the product and the proposed price, where the normal price checks run and a price under the margin floor needs a
//     SECOND person's own approval before it is saved (ADR-0024). A markdown is a price change; no rule and no AI commits it
//     (hard rule #5).
//   • The COMPETITOR RULE (Products and prices) — `GET /v1/prices/competitor-rule` (`price.change.propose`) and
//     `POST /v1/prices/competitor-rule` { gapBps, maxAgeDays, reason } (`price.change.approve`, the owner): how far below us
//     and how freshly seen a competitor must be before a price change is DRAFTED. A new version; nothing is repriced.
// Every word has a Tamil twin; head office's own sentences stay English.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOfTyped } from './price-checks-session';

export type Lang = 'en' | 'ta';

export interface MarkdownProposalRow {
  readonly productId: string; readonly batchId: string | null; readonly remainingShelfLifeDays: number; readonly onHandMinor: number;
  readonly projectedSalesMinor: number; readonly surplusMinor: number; readonly markdownBps: number; readonly currentPriceMinor: number;
  readonly newPriceMinor: number; readonly reason: string;
}
export interface ClearanceRead {
  readonly storeId: string; readonly asOf: string; readonly suggestions: readonly MarkdownProposalRow[];
  readonly notJudged: readonly { readonly productId: string; readonly batchId: string | null; readonly onHandMinor: number; readonly because: string }[];
}
export interface CompetitorRuleRead {
  readonly gapBps: number; readonly maxAgeDays: number; readonly source: string; readonly version: number | null; readonly setBy: string | null;
  readonly history: readonly { readonly version: number; readonly gapBps: number; readonly maxAgeDays: number; readonly reason: string; readonly setBy: string; readonly setAt: string }[];
}

export const MARKDOWN_COPY = {
  en: {
    proposeH: 'Work out a markdown', proposeLead: 'For stock that will not sell before its date: head office works out how much to take off from the days left and how fast it sells here. This changes no price — a person sends it for approval.',
    product: 'Product code', batch: 'Batch (optional)', daysLeft: 'Days left before its date', onHand: 'How many on hand', price: 'Price now (₹, blank for the shelf price)', rate: 'Sells a day (blank: head office works it out)',
    propose: 'Work out the markdown', proposing: 'Working it out…', pickRow: 'Work out a markdown',
    proposal: '{off}% off: {from} → {to}', noMarkdown: 'No markdown proposed: {why}.', surplus: '{n} of {held} will not sell in time at the current rate.',
    sendForApproval: 'Send this price for approval', sendLead: 'Opens "Change a price" with this product and price. The normal price checks run there; a price under the margin floor needs a second person\'s approval before it is saved.',
    r_marked_down: 'marked down', r_will_clear: 'at the current rate it all sells before its date', r_too_early: 'its date is not near enough yet',
    clearanceH: 'Clearance suggestions', clearanceLead: 'Every product on clearance at this store, batch by batch, through the same markdown ladder. Suggestions only; nothing is cut automatically.',
    clearanceShow: 'Show the suggestions', noSuggestions: 'No clearance product holds stock that needs a markdown at this store.',
    notJudgedH: 'Not judged, and why', nj_no_sell_by_date_known: 'no sell-by date on record', nj_no_shelf_price: 'no shelf price', nj_expired: 'already past its date',
    ruleH: 'When a competitor drafts a price change', ruleLead: 'A price change is drafted only when a competitor is this far below us and was seen this recently. Drafts change no price; a person approves each one.',
    ruleNow: 'In force: {gap}% or more below us, seen under {age} days ago', ruleOwner: '(your setting, version {v})', ruleDefault: '(the agreed starting setting)',
    gap: 'How far below us (%)', age: 'Seen within (days)', reason: 'Why it changes (kept with the version)', setRule: 'Save the rule', ruleSaved: 'Saved as version {v}. No price was changed.', ruleSame: 'That is already the rule in force.',
    ruleOwnerOnly: 'Only the owner can change this rule.',
    nobody: 'Nobody is signed in on this screen.', cannotPropose: 'Your role cannot propose price changes.', cannotSetRule: 'Only someone who approves prices can change the rule.',
    needProduct: 'Type the product code.', badDays: 'Type the days left, a whole number (0 or more).', badQty: 'Type how many are on hand, a whole number.', badPrice: 'Type the price in rupees, e.g. 49.50, or leave it blank.', badRate: 'Type how many sell a day, a whole number, or leave it blank.',
    noStore: 'This screen was not told which store it is for.', noShelfPrice: 'Head office has no shelf price for this product here — type the price now.',
    badGap: 'Type the gap as a percentage, e.g. 5 or 7.5.', badAge: 'Type the days, a whole number above 0.', needReason: 'Write why the rule changes.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', saving: 'Saving…', reading: 'Reading from head office…',
  },
  ta: {
    proposeH: 'விலைக் குறைப்பைக் கணக்கிடு', proposeLead: 'தேதிக்கு முன் விற்காத சரக்குக்கு: மீதமுள்ள நாட்களையும் இங்கே எவ்வளவு வேகமாக விற்கிறது என்பதையும் வைத்து எவ்வளவு குறைக்க வேண்டும் என்று தலைமை அலுவலகம் கணக்கிடும். இது எந்த விலையையும் மாற்றாது — ஒருவர் ஒப்புதலுக்கு அனுப்புவார்.',
    product: 'பொருள் குறியீடு', batch: 'தொகுதி (விருப்பம்)', daysLeft: 'தேதிக்கு முன் மீதமுள்ள நாட்கள்', onHand: 'கையிருப்பு எத்தனை', price: 'இப்போதைய விலை (₹, அடுக்கு விலைக்குக் காலியாக விடுங்கள்)', rate: 'ஒரு நாளில் விற்பது (காலி: தலைமை அலுவலகம் கணக்கிடும்)',
    propose: 'விலைக் குறைப்பைக் கணக்கிடு', proposing: 'கணக்கிடுகிறது…', pickRow: 'விலைக் குறைப்பைக் கணக்கிடு',
    proposal: '{off}% குறைவு: {from} → {to}', noMarkdown: 'விலைக் குறைப்பு முன்மொழியப்படவில்லை: {why}.', surplus: 'இப்போதைய வேகத்தில் {held}-இல் {n} நேரத்தில் விற்காது.',
    sendForApproval: 'இந்த விலையை ஒப்புதலுக்கு அனுப்பு', sendLead: 'இந்தப் பொருளுடனும் விலையுடனும் "விலையை மாற்று" திறக்கும். வழக்கமான விலைச் சரிபார்ப்புகள் அங்கே நடக்கும்; லாப வரம்புக்குக் கீழான விலைக்குச் சேமிக்கும் முன் இரண்டாவது நபரின் ஒப்புதல் தேவை.',
    r_marked_down: 'விலை குறைக்கப்பட்டது', r_will_clear: 'இப்போதைய வேகத்தில் தேதிக்கு முன் அனைத்தும் விற்றுவிடும்', r_too_early: 'அதன் தேதி இன்னும் போதுமான அளவு நெருங்கவில்லை',
    clearanceH: 'விற்றுத்தீர்க்கும் பரிந்துரைகள்', clearanceLead: 'இந்தக் கடையில் விற்றுத்தீர்க்கும் ஒவ்வொரு பொருளும், தொகுதி வாரியாக, அதே விலைக் குறைப்பு ஏணியில். பரிந்துரைகள் மட்டுமே; எதுவும் தானாகக் குறைக்கப்படாது.',
    clearanceShow: 'பரிந்துரைகளைக் காட்டு', noSuggestions: 'இந்தக் கடையில் விலைக் குறைப்பு தேவைப்படும் சரக்கு எந்த விற்றுத்தீர்க்கும் பொருளிலும் இல்லை.',
    notJudgedH: 'மதிப்பிடப்படாதவை, ஏன்', nj_no_sell_by_date_known: 'விற்கும் கடைசி தேதி பதிவில் இல்லை', nj_no_shelf_price: 'அடுக்கு விலை இல்லை', nj_expired: 'ஏற்கனவே தேதி கடந்தது',
    ruleH: 'போட்டியாளர் விலை மாற்றத்தை எப்போது வரைவு செய்கிறார்', ruleLead: 'ஒரு போட்டியாளர் நம்மைவிட இவ்வளவு குறைவாகவும் இவ்வளவு சமீபத்தில் பார்க்கப்பட்டும் இருந்தால் மட்டுமே விலை மாற்றம் வரைவு செய்யப்படும். வரைவுகள் எந்த விலையையும் மாற்றாது; ஒவ்வொன்றுக்கும் ஒருவர் ஒப்புதல் அளிப்பார்.',
    ruleNow: 'நடைமுறையில்: நம்மைவிட {gap}% அல்லது அதற்கு மேல் குறைவு, {age} நாட்களுக்குள் பார்த்தது', ruleOwner: '(உங்கள் அமைப்பு, பதிப்பு {v})', ruleDefault: '(ஒப்புக்கொண்ட தொடக்க அமைப்பு)',
    gap: 'நம்மைவிட எவ்வளவு குறைவு (%)', age: 'எத்தனை நாட்களுக்குள் பார்த்தது', reason: 'ஏன் மாறுகிறது (பதிப்புடன் வைக்கப்படும்)', setRule: 'விதியைச் சேமி', ruleSaved: 'பதிப்பு {v} ஆகச் சேமிக்கப்பட்டது. எந்த விலையும் மாற்றப்படவில்லை.', ruleSame: 'அதுவே ஏற்கனவே நடைமுறை விதி.',
    ruleOwnerOnly: 'உரிமையாளர் மட்டுமே இந்த விதியை மாற்ற முடியும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotPropose: 'உங்கள் பங்கால் விலை மாற்றங்களை முன்மொழிய முடியாது.', cannotSetRule: 'விலைகளுக்கு ஒப்புதல் அளிப்பவர் மட்டுமே விதியை மாற்ற முடியும்.',
    needProduct: 'பொருள் குறியீட்டைத் தட்டச்சு செய்யுங்கள்.', badDays: 'மீதமுள்ள நாட்களை முழு எண்ணாகத் தட்டச்சு செய்யுங்கள் (0 அல்லது அதற்கு மேல்).', badQty: 'கையிருப்பை முழு எண்ணாகத் தட்டச்சு செய்யுங்கள்.', badPrice: 'விலையை ரூபாயில் தட்டச்சு செய்யுங்கள், எ.கா. 49.50, அல்லது காலியாக விடுங்கள்.', badRate: 'ஒரு நாளில் விற்பதை முழு எண்ணாகத் தட்டச்சு செய்யுங்கள், அல்லது காலியாக விடுங்கள்.',
    noStore: 'இந்தத் திரைக்கு எந்தக் கடை என்று சொல்லப்படவில்லை.', noShelfPrice: 'இங்கே இந்தப் பொருளுக்குத் தலைமை அலுவலகத்திடம் அடுக்கு விலை இல்லை — இப்போதைய விலையைத் தட்டச்சு செய்யுங்கள்.',
    badGap: 'வேறுபாட்டைச் சதவீதமாகத் தட்டச்சு செய்யுங்கள், எ.கா. 5 அல்லது 7.5.', badAge: 'நாட்களை 0க்கு மேல் முழு எண்ணாகத் தட்டச்சு செய்யுங்கள்.', needReason: 'விதி ஏன் மாறுகிறது என்று எழுதுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ மாற்றவோ இல்லை.', saving: 'சேமிக்கிறது…', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const markdownWords = (lang: Lang, key: string, slots?: Readonly<Record<string, string | number>>): string => {
  const raw = (MARKDOWN_COPY[lang] as Record<string, string>)[key] ?? (MARKDOWN_COPY.en as Record<string, string>)[key] ?? key;
  return Object.entries(slots ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), raw);
};
export const markdownOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => markdownWords(lang, k), out);

/** "Change a price" on Products and prices, holding this product and this price (in rupees) — where approval happens.
 *  Relative, as the office pages link to one another (each is served at /<page>/ on the store computer). */
export function priceChangeLink(productId: string, priceMinor: number): string {
  return `../catalogue/?tab=price&product=${encodeURIComponent(productId)}&price=${encodeURIComponent((priceMinor / 100).toFixed(2))}`;
}

type Why = 'nobody' | 'cannotPropose' | 'cannotSetRule' | 'needProduct' | 'badDays' | 'badQty' | 'badPrice' | 'badRate' | 'noStore' | 'noShelfPrice' | 'badGap' | 'badAge' | 'needReason';

export interface MarkdownInput {
  readonly productId: string; readonly batchId: string; readonly daysLeft: string; readonly onHand: string; readonly price: string; readonly rate: string;
}

export interface MarkdownSession {
  readonly may: { readonly named: boolean; readonly propose: boolean; readonly setRule: boolean };
  readonly storeId: string | null;
  propose(input: MarkdownInput): Promise<Outcome<MarkdownProposalRow, Why>>;
  clearance(): Promise<Outcome<ClearanceRead, Why>>;
  rule(): Promise<Outcome<CompetitorRuleRead, Why>>;
  setRule(input: { readonly gapPercent: string; readonly maxAgeDays: string; readonly reason: string }): Promise<Outcome<{ readonly version: number | null; readonly alreadyInForce: boolean }, Why>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const wholeOf = (typed: string): number | undefined => (/^\d{1,9}$/.test(typed.trim()) ? Number(typed.trim()) : undefined);

const proposalOf = (p: Record<string, unknown>): MarkdownProposalRow => ({
  productId: str(p['productId']), batchId: typeof p['batchId'] === 'string' ? p['batchId'] : null, remainingShelfLifeDays: num(p['remainingShelfLifeDays']),
  onHandMinor: num(p['onHandMinor']), projectedSalesMinor: num(p['projectedSalesMinor']), surplusMinor: num(p['surplusMinor']), markdownBps: num(p['markdownBps']),
  currentPriceMinor: num(p['currentPriceMinor']), newPriceMinor: num(p['newPriceMinor']), reason: str(p['reason']),
});

export function createMarkdownSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly storeId?: string; readonly fetch?: typeof globalThis.fetch; readonly now?: () => string;
}): MarkdownSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, propose: named && held.has('price.change.propose'), setRule: named && held.has('price.change.approve') };
  const storeId = input.storeId?.trim() || null;
  const call = makeCaller({ keyPrefix: 'markdown', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const now = input.now ?? (() => new Date().toISOString());
  const no = (why: Why): Outcome<never, Why> => ({ result: 'invalid', why });
  const mayPropose = (): Outcome<never, Why> | undefined => (!named ? no('nobody') : !may.propose ? no('cannotPropose') : undefined);
  return {
    may, storeId,
    propose: async (m) => {
      const stop = mayPropose(); if (stop !== undefined) return stop;
      const productId = m.productId.trim();
      if (productId === '') return no('needProduct');
      const days = wholeOf(m.daysLeft); if (days === undefined) return no('badDays');
      const onHand = wholeOf(m.onHand); if (onHand === undefined) return no('badQty');
      const rate = m.rate.trim() === '' ? null : wholeOf(m.rate); if (rate === undefined) return no('badRate');
      let price = m.price.trim() === '' ? null : paiseOfTyped(m.price); if (price === undefined) return no('badPrice');
      if (price === null) {
        // today's shelf price of record at this store — never a price the page made up
        if (storeId === null) return no('noStore');
        const resolved = await call<{ priceMinor?: unknown }>('GET', `/v1/prices/list/${encodeURIComponent(productId)}/resolve?storeId=${encodeURIComponent(storeId)}&at=${encodeURIComponent(now())}`);
        if (resolved.result === 'refused' && resolved.status === 404) return no('noShelfPrice');
        if (resolved.result !== 'ok') return resolved;
        if (typeof resolved.value.priceMinor !== 'number') return no('noShelfPrice');
        price = resolved.value.priceMinor;
      }
      const out = await call<{ proposals?: unknown }>('POST', '/v1/pricing/markdown/propose', {
        items: [{ productId, ...(m.batchId.trim() === '' ? {} : { batchId: m.batchId.trim() }), remainingShelfLifeDays: days, onHandMinor: onHand, currentPriceMinor: price, ...(rate === null ? {} : { avgDailyDemand: rate }) }],
      });
      if (out.result !== 'ok') return out;
      const first = (Array.isArray(out.value.proposals) ? out.value.proposals : []).filter(isObj)[0];
      return { result: 'ok', value: proposalOf(first ?? {}) };
    },
    clearance: async () => {
      const stop = mayPropose(); if (stop !== undefined) return stop;
      if (storeId === null) return no('noStore');
      const out = await call<Record<string, unknown>>('GET', `/v1/pricing/clearance-markdowns?storeId=${encodeURIComponent(storeId)}`);
      if (out.result !== 'ok') return out;
      return {
        result: 'ok', value: {
          storeId: str(out.value['storeId']) || storeId, asOf: str(out.value['asOf']),
          suggestions: (Array.isArray(out.value['suggestions']) ? out.value['suggestions'] : []).filter(isObj).map(proposalOf),
          notJudged: (Array.isArray(out.value['notJudged']) ? out.value['notJudged'] : []).filter(isObj).map((n) => ({ productId: str(n['productId']), batchId: typeof n['batchId'] === 'string' ? n['batchId'] : null, onHandMinor: num(n['onHandMinor']), because: str(n['because']) })),
        },
      };
    },
    rule: async () => {
      const stop = mayPropose(); if (stop !== undefined) return stop;
      const out = await call<Record<string, unknown>>('GET', '/v1/prices/competitor-rule');
      if (out.result !== 'ok') return out;
      const r = isObj(out.value['rule']) ? out.value['rule'] : {};
      return {
        result: 'ok', value: {
          gapBps: num(r['gapBps']), maxAgeDays: num(r['maxAgeDays']), source: str(out.value['source']),
          version: typeof out.value['version'] === 'number' ? out.value['version'] : null, setBy: typeof out.value['setBy'] === 'string' ? out.value['setBy'] : null,
          history: (Array.isArray(out.value['history']) ? out.value['history'] : []).filter(isObj).map((h) => ({ version: num(h['version']), gapBps: num(h['gapBps']), maxAgeDays: num(h['maxAgeDays']), reason: str(h['reason']), setBy: str(h['setBy']), setAt: str(h['setAt']) })),
        },
      };
    },
    setRule: async (r) => {
      if (!named) return no('nobody');
      if (!may.setRule) return no('cannotSetRule');
      const g = r.gapPercent.trim().replace(',', '.');
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(g) || Number(g) <= 0) return no('badGap');
      const age = wholeOf(r.maxAgeDays); if (age === undefined || age <= 0) return no('badAge');
      if (r.reason.trim() === '') return no('needReason');
      const out = await call<{ rule?: unknown; alreadyInForce?: unknown }>('POST', '/v1/prices/competitor-rule', { gapBps: Math.round(Number(g) * 100), maxAgeDays: age, reason: r.reason.trim() });
      if (out.result !== 'ok') return out;
      const rule = isObj(out.value.rule) ? out.value.rule : {};
      return { result: 'ok', value: { version: typeof rule['version'] === 'number' ? rule['version'] : null, alreadyInForce: out.value.alreadyInForce === true } };
    },
  };
}
