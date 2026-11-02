// Customer value (W3 · D07-FR-05 · M16-FR-04 · M16-FR-02) — the page over head office's value ranking and segment rules
// (services/customer/src/segments.ts), which no screen reached:
//   • the RANKING — `GET /v1/customer/segments/value-ranking?top=` — the customers worth most to the shop by the MARGIN they
//     bring, not their spend; both are shown, because the two orders differ and the difference is the point. A customer who
//     has not agreed to be analysed is left out of the ranking by head office (never guessed at);
//   • the SEGMENT RULES — `GET/POST /v1/customer/segments/policy` — how many bills make a customer "new" or "loyal", how many
//     days without a bill make them "lapsing" or "lapsed", and how many bills before any group is claimed. A rule left empty
//     keeps head office's standard number (shown, never invented here). Reading needs `customer.segment.read`; changing the
//     rules `customer.segment.manage`; head office re-checks each.
// Head office's own sentences stay in English (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

/** The rule names head office reads, and the standard number each takes when the shop has not set its own. */
export const SEGMENT_RULES = ['newBelowOrders', 'loyalAtOrders', 'lapsingAfterDays', 'lapsedAfterDays', 'minimumHistory'] as const;
export type SegmentRule = (typeof SEGMENT_RULES)[number];
export const STANDARD_RULES: Readonly<Record<SegmentRule, number>> = Object.freeze({ newBelowOrders: 2, loyalAtOrders: 10, lapsingAfterDays: 60, lapsedAfterDays: 180, minimumHistory: 1 });

export const CUSTOMER_VALUE_COPY = {
  en: {
    title: 'Customer value',
    lead: 'The customers worth most to the shop — by the profit their bills bring, not only what they spend — and the rules that put each customer in a group (new, regular, loyal, lapsing, lapsed). A customer who has not agreed to be analysed is not ranked.',
    rankH: 'Most valuable customers', top: 'How many to show', show: 'Show the ranking', none: 'No customer can be ranked yet.',
    margin: 'profit brought', spend: 'spent', marginRate: 'profit rate', notMeaningful: 'not meaningful',
    rulesH: 'Group rules', rulesNote: 'Leave a box empty to keep the standard number. A change applies to every group and ranking from now on.',
    rule_newBelowOrders: 'New until this many bills', rule_loyalAtOrders: 'Loyal from this many bills', rule_lapsingAfterDays: 'Lapsing after this many days without a bill',
    rule_lapsedAfterDays: 'Lapsed after this many days without a bill', rule_minimumHistory: 'Bills needed before any group is given',
    standard: 'standard', shopsOwn: 'set by the shop', allStandard: 'The shop uses the standard numbers.', save: 'Save the rules', saved: 'Saved. Every group and ranking now uses these rules.',
    needWhole: 'Each rule is a whole number, 0 or more.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see customer value.', cannotManage: 'You can see the rules; changing them needs the manager\'s permission.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'வாடிக்கையாளர் மதிப்பு',
    lead: 'கடைக்கு அதிக மதிப்புள்ள வாடிக்கையாளர்கள் — அவர்கள் செலவழிப்பது மட்டுமல்ல, அவர்களின் பில்கள் தரும் லாபத்தால் — மற்றும் ஒவ்வொரு வாடிக்கையாளரையும் ஒரு குழுவில் வைக்கும் விதிகள் (புதியவர், வழக்கமானவர், விசுவாசமானவர், விலகிச் செல்பவர், விலகியவர்). பகுப்பாய்வுக்கு ஒப்புக்கொள்ளாத வாடிக்கையாளர் தரவரிசையில் இல்லை.',
    rankH: 'அதிக மதிப்புள்ள வாடிக்கையாளர்கள்', top: 'எத்தனை காட்ட வேண்டும்', show: 'தரவரிசையைக் காட்டு', none: 'இன்னும் எந்த வாடிக்கையாளரையும் தரவரிசைப்படுத்த முடியாது.',
    margin: 'தந்த லாபம்', spend: 'செலவழித்தது', marginRate: 'லாப விகிதம்', notMeaningful: 'பொருந்தாது',
    rulesH: 'குழு விதிகள்', rulesNote: 'வழக்கமான எண்ணை வைக்கப் பெட்டியைக் காலியாக விடுங்கள். மாற்றம் இனி ஒவ்வொரு குழுவுக்கும் தரவரிசைக்கும் பொருந்தும்.',
    rule_newBelowOrders: 'இத்தனை பில்கள் வரை புதியவர்', rule_loyalAtOrders: 'இத்தனை பில்களிலிருந்து விசுவாசமானவர்', rule_lapsingAfterDays: 'பில் இல்லாமல் இத்தனை நாட்களுக்குப் பின் விலகிச் செல்பவர்',
    rule_lapsedAfterDays: 'பில் இல்லாமல் இத்தனை நாட்களுக்குப் பின் விலகியவர்', rule_minimumHistory: 'குழு வழங்கும் முன் தேவையான பில்கள்',
    standard: 'வழக்கமானது', shopsOwn: 'கடை அமைத்தது', allStandard: 'கடை வழக்கமான எண்களைப் பயன்படுத்துகிறது.', save: 'விதிகளைச் சேமி', saved: 'சேமிக்கப்பட்டது. ஒவ்வொரு குழுவும் தரவரிசையும் இப்போது இந்த விதிகளைப் பயன்படுத்துகின்றன.',
    needWhole: 'ஒவ்வொரு விதியும் 0 அல்லது அதற்கு மேற்பட்ட முழு எண்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு வாடிக்கையாளர் மதிப்பைப் பார்க்க முடியாது.', cannotManage: 'விதிகளைப் பார்க்கலாம்; மாற்ற மேலாளர் அனுமதி தேவை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const customerValueWords = (lang: Lang, key: string): string =>
  (CUSTOMER_VALUE_COPY[lang] as Record<string, string>)[key] ?? (CUSTOMER_VALUE_COPY.en as Record<string, string>)[key] ?? key;
export const customerValueOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => customerValueWords(lang, k), out);

export interface RankedCustomer { readonly rank: number; readonly customerRef: string; readonly marginMinor: number; readonly spendMinor: number; readonly marginBps: number | 'not_meaningful' }
export interface RuleView { readonly rule: SegmentRule; readonly value: number; readonly shopsOwn: boolean }
export interface RulesView { readonly rules: readonly RuleView[]; readonly set: boolean }

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needWhole';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The rules as the page shows them: the shop's own number where it set one, the standard number otherwise. */
export function rulesView(policy: Readonly<Record<string, unknown>>, set: boolean): RulesView {
  return {
    set,
    rules: SEGMENT_RULES.map((rule) => {
      const own = policy[rule];
      return typeof own === 'number' && Number.isInteger(own) ? { rule, value: own, shopsOwn: true } : { rule, value: STANDARD_RULES[rule], shopsOwn: false };
    }),
  };
}

/** Read the typed rules: empty keeps the standard; anything else must be a whole number ≥ 0 (head office's own check). */
export function readRules(typed: Readonly<Partial<Record<SegmentRule, string>>>): Partial<Record<SegmentRule, number>> | Why {
  const out: Partial<Record<SegmentRule, number>> = {};
  for (const rule of SEGMENT_RULES) {
    const raw = (typed[rule] ?? '').trim();
    if (raw === '') continue;
    if (!/^\d+$/.test(raw)) return 'needWhole';
    out[rule] = Number(raw);
  }
  return out;
}

export interface CustomerValueSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  ranking(top: number): Done<readonly RankedCustomer[]>;
  rules(): Done<RulesView>;
  saveRules(typed: Readonly<Partial<Record<SegmentRule, string>>>): Done<RulesView>;
}

export function createCustomerValueSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): CustomerValueSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('customer.segment.read'), manage: named && held.has('customer.segment.manage') };
  const call = makeCaller({ keyPrefix: 'cvalue', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'manage') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotManage') : undefined);
  const rules = async (): Done<RulesView> => {
    const out = await call<{ policy?: unknown; set?: unknown }>('GET', '/v1/customer/segments/policy');
    if (out.result !== 'ok') return out;
    return { result: 'ok', value: rulesView(isObj(out.value.policy) ? out.value.policy : {}, out.value.set === true) };
  };
  return {
    may,
    ranking: async (top) => {
      const g = gate('read'); if (g) return g;
      const n = Number.isInteger(top) && top > 0 ? Math.min(top, 100) : 10;
      const out = await call<{ ranking?: unknown[] }>('GET', `/v1/customer/segments/value-ranking?top=${n}`);
      if (out.result !== 'ok') return out;
      return {
        result: 'ok',
        value: (out.value.ranking ?? []).flatMap((r, i): RankedCustomer[] => (isObj(r) && typeof r['customerRef'] === 'string'
          ? [{ rank: i + 1, customerRef: r['customerRef'], marginMinor: num(r['lifetimeMarginMinor']), spendMinor: num(r['lifetimeRevenueMinor']), marginBps: typeof r['marginBps'] === 'number' ? r['marginBps'] : 'not_meaningful' }]
          : [])),
      };
    },
    rules: async () => gate('read') ?? rules(),
    saveRules: async (typed) => {
      const g = gate('manage'); if (g) return g;
      const policy = readRules(typed);
      if (typeof policy === 'string') return no(policy);
      const out = await call('POST', '/v1/customer/segments/policy', policy);
      return out.result === 'ok' ? rules() : out;
    },
  };
}
