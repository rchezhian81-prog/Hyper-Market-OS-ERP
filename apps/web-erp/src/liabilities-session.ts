// Month-end · "Owed to customers" (W3 · D10-FR-04 "loyalty/gift/rebate liabilities" · M17-FR-01/03 "balances reconcile to
// finance" · P-08 · hard rule #2) — a tested, DOM-free session over the two head-office reads no screen reached, and the
// one post:
//   • LOYALTY POINTS AND STORE CREDIT (`GET /v1/finance/loyalty-liability`): what the members hold (points at the point
//     value in force, and every store-credit balance) against what the books carry on the liability accounts, exactly;
//   • REFERRAL REWARDS (`GET /v1/finance/referral-liability`): rewards earned and not yet paid or lapsed against the books —
//     "not known" (never zero) while the accountant has not mapped the rule — and PUT THEM IN THE BOOKS
//     (`POST /v1/finance/referral-liability/post`): each movement not yet posted, through the accountant's rule.
// A difference is shown with its sign and value; a person settles it. Head office re-checks every permission.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const LIABILITIES_COPY = {
  en: {
    tab: 'Owed to customers', heading: 'What the shop owes customers', lede: 'Loyalty points, store credit and referral rewards are money the shop owes. Each is shown as the members hold it and as the books carry it — to the paisa. A difference is a day not yet posted, value used twice, or a changed point value; a person settles it.',
    show: 'Read the figures', loyaltyH: 'Loyalty points', creditH: 'Store credit', referralH: 'Referral rewards',
    held: 'Members hold', books: 'The books carry', difference: 'Difference', agrees: 'agrees exactly', differs: 'does not agree',
    points: '{points} points at {value} each', notKnown: 'not known', notMapped: 'The accountant has not set the posting rule for referral rewards yet — the books carry no referral liability. Not known, not zero.',
    owed: 'Rewards still owed', unposted: '{count} movement(s) not yet in the books', post: 'Put referral rewards in the books', posted: '{count} entr(ies) put in the books.', nothingToPost: 'Nothing to post — every movement is in the books.',
    notPosted: 'Not posted: {kind} ({reason})', coupons: 'Coupons', account: 'Account',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the books.', cannotPost: 'Your role cannot post to the books.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Reading from head office…',
  },
  ta: {
    tab: 'வாடிக்கையாளர்களுக்குச் செலுத்த வேண்டியது', heading: 'கடை வாடிக்கையாளர்களுக்குச் செலுத்த வேண்டியது', lede: 'விசுவாசப் புள்ளிகள், கடை வரவு, பரிந்துரை வெகுமதிகள் ஆகியவை கடை செலுத்த வேண்டிய பணம். ஒவ்வொன்றும் உறுப்பினர்கள் வைத்திருப்பதாகவும் புத்தகம் காட்டுவதாகவும் — பைசா வரை — காட்டப்படும். வேறுபாடு என்பது இன்னும் பதியாத நாள், இருமுறை பயன்பட்ட மதிப்பு, அல்லது மாறிய புள்ளி மதிப்பு; ஒருவர் அதைத் தீர்க்கிறார்.',
    show: 'எண்களைப் படி', loyaltyH: 'விசுவாசப் புள்ளிகள்', creditH: 'கடை வரவு', referralH: 'பரிந்துரை வெகுமதிகள்',
    held: 'உறுப்பினர்கள் வைத்திருப்பது', books: 'புத்தகம் காட்டுவது', difference: 'வேறுபாடு', agrees: 'சரியாகப் பொருந்துகிறது', differs: 'பொருந்தவில்லை',
    points: '{points} புள்ளிகள், ஒவ்வொன்றும் {value}', notKnown: 'தெரியவில்லை', notMapped: 'பரிந்துரை வெகுமதிகளுக்கான பதிவு விதியைக் கணக்காளர் இன்னும் அமைக்கவில்லை — புத்தகத்தில் பரிந்துரைப் பொறுப்பு இல்லை. தெரியவில்லை, பூஜ்ஜியம் அல்ல.',
    owed: 'இன்னும் செலுத்த வேண்டிய வெகுமதிகள்', unposted: '{count} அசைவுகள் இன்னும் புத்தகத்தில் இல்லை', post: 'பரிந்துரை வெகுமதிகளைப் புத்தகத்தில் சேர்', posted: '{count} பதிவுகள் புத்தகத்தில் சேர்க்கப்பட்டன.', nothingToPost: 'பதிய எதுவும் இல்லை — ஒவ்வொரு அசைவும் புத்தகத்தில் உள்ளது.',
    notPosted: 'பதியப்படவில்லை: {kind} ({reason})', coupons: 'கூப்பன்கள்', account: 'கணக்கு',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு கணக்குப் புத்தகத்தைப் பார்க்க முடியாது.', cannotPost: 'உங்கள் பங்கு புத்தகத்தில் பதிய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export function liabilitiesWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (LIABILITIES_COPY[lang] as Record<string, string>)[key] ?? (LIABILITIES_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const liabilitiesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => liabilitiesWords(lang, k), out);

export interface LoyaltyLiability {
  readonly points: { readonly account: string; readonly outstandingPoints: number; readonly pointValuePaise: number; readonly heldValueMinor: number; readonly postedMinor: number; readonly differenceMinor: number; readonly reconciles: boolean };
  readonly storeCredit: { readonly account: string; readonly heldMinor: number; readonly postedMinor: number; readonly differenceMinor: number; readonly reconciles: boolean };
  readonly reconciles: boolean; readonly detail: string;
}
export interface ReferralLiability {
  readonly register: { readonly outstandingMinor: number };
  readonly account: string | null; readonly booksMinor: number | null; readonly differenceMinor: number | null; readonly reconciles: boolean;
  readonly exception: { readonly code: string; readonly detail: string } | null;
  readonly unposted: readonly unknown[]; readonly coupons: { readonly liability: boolean; readonly detail: string };
}
export interface Liabilities { readonly loyalty: LoyaltyLiability; readonly referral: ReferralLiability }
export interface ReferralPost { readonly posted: readonly { readonly entryId: string }[]; readonly exceptions: readonly { readonly movementId: string; readonly kind: string; readonly reason: string; readonly detail: string }[] }

type Why = 'nobody' | 'cannotRead' | 'cannotPost';

export interface LiabilitiesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly post: boolean };
  read(): Promise<Outcome<Liabilities, Why>>;
  postReferrals(): Promise<Outcome<ReferralPost, Why>>;
}

export function createLiabilitiesSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): LiabilitiesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('finance.period.read'), post: named && held.has('finance.journal.post') };
  const call = makeCaller({ keyPrefix: 'liabilities', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  return {
    may,
    read: async () => {
      if (!named) return no('nobody');
      if (!may.read) return no('cannotRead');
      const [l, r] = await Promise.all([call<LoyaltyLiability>('GET', '/v1/finance/loyalty-liability'), call<ReferralLiability>('GET', '/v1/finance/referral-liability')]);
      if (l.result !== 'ok') return l;
      if (r.result !== 'ok') return r;
      return { result: 'ok', value: { loyalty: l.value, referral: r.value } };
    },
    postReferrals: async () => (!named ? no('nobody') : !may.post ? no('cannotPost') : call('POST', '/v1/finance/referral-liability/post', {})),
  };
}
